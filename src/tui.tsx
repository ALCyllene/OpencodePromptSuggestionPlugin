import { appendFileSync } from "node:fs";
import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";

/**
 * Debug mode: `PSG_DEBUG=/path/to/file` traces the plugin's life (load,
 * generation, acceptance) into that file.
 */
const DEBUG_FILE = process.env.PSG_DEBUG ?? "";
const dbg = (m: string): void => {
  if (!DEBUG_FILE) return;
  try {
    appendFileSync(DEBUG_FILE, m + "\n");
  } catch {
    /* debug only */
  }
};

/**
 * Claude Code-style "prompt suggestion" plugin for the OpenCode TUI.
 *
 * At the end of every turn (`session.execution.succeeded` event), the plugin
 * asks the model for a short "next question / action" built from the last
 * messages of the session (`client.session.context`), using a stateless
 * `client.experimental.generate.text` call. The suggestion is shown as ghost
 * text above the prompt; Tab inserts it into the input field.
 *
 * TUI module V2: `Plugin.define({ id, setup })`, package entrypoint `./tui`.
 * Typed against the official `Context` from `@opencode/plugin/tui`.
 */

const SYSTEM_PROMPT = [
  "You suggest the logical next step for a developer working with a coding assistant.",
  "From the conversation provided, write ONE single suggestion for the next question or action.",
  "Format: one short sentence (at most 140 characters), no final period, no quotes, no list.",
  "Reply ONLY with the suggestion text: no preamble, no explanation.",
].join("\n");

/**
 * Reasoning-effort variant used for the generation call: the suggestion is not
 * worth the full reasoning effort of the default model. If the default model
 * has no such variant, the server refuses without any LLM call; the caller
 * then retries without a variant.
 */
const LOW_VARIANT = "low";

/** Cleans the model output for ghost-text display. */
function cleanSuggestion(raw: string): string {
  return raw
    .replace(/^(?:suggestion|answer|here is|here's)\s*:?\s*/i, "")
    .replace(/^[\s"'`«»]+|[\s"'`«»]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim()
    .slice(0, 200);
}

/**
 * The config default model (last document defining it, in merge order).
 * Returns `null` when unavailable, in which case the generation is performed
 * without a `model` (the server falls back to its own default model).
 */
async function resolveDefaultModel(
  context: Plugin.Context
): Promise<{ providerID: string; id: string } | null> {
  try {
    const docs = await context.client.config.get({});
    if (!Array.isArray(docs)) return null;
    for (let i = docs.length - 1; i >= 0; i--) {
      const doc = docs[i];
      if (!doc || doc.type !== "document") continue;
      const model = doc.info?.model;
      if (!model) continue;
      if (typeof model === "string") {
        // "providerID/modelID" (an optional "#variant" suffix is ignored).
        const ref = model.split("#")[0];
        const slash = ref.indexOf("/");
        if (slash > 0) return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
      } else if (model.providerID && model.model) {
        return { providerID: model.providerID, id: model.model };
      }
    }
  } catch {
    /* config unavailable: generate without a model */
  }
  return null;
}

/** Builds a short textual context from the last messages of the session. */
async function buildConversation(
  context: Plugin.Context,
  sessionID: string
): Promise<string> {
  try {
    const messages = await context.client.session.context({ sessionID });
    if (!Array.isArray(messages)) return "";
    const result = messages
      .slice(-8)
      .map((m): string => {
        const body =
          m.type === "assistant"
            ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim()
            : m.type === "user"
              ? m.text.trim()
              : "";
        return body ? `[${m.type}] ${body.slice(0, 800)}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    dbg("conversation: " + result.length + " chars, " + messages.length + " messages");
    return result;
  } catch {
    return "";
  }
}
 
export default Plugin.define({
  id: "opencode-prompt-suggestion",
  async setup(context: Plugin.Context) {
    dbg("setup called (app " + JSON.stringify(context.app) + ")");

    // The currently displayed suggestion: which session it belongs to, its text.
    const [suggestionFor, setSuggestionFor] = createSignal<string | null>(null);
    const [suggestionText, setSuggestionText] = createSignal<string | null>(null);
    // The session whose suggestion is being generated ("loading" state).
    const [generatingFor, setGeneratingFor] = createSignal<string | null>(null);

    // The session rendered by the slot (the one the user is looking at).
    let renderedSessionID: string | null = null;
    // One generation in flight at a time.
    let inFlight = false;
    // Invalidation token: incremented on every clear() so that a result
    // generated in the meantime (e.g. the user typed a new prompt) is dropped
    // instead of reappearing.
    let genToken = 0;

    const clear = () => {
      genToken++;
      setSuggestionFor(null);
      setSuggestionText(null);
      setGeneratingFor(null);
    };

    // Ghost-text color: the `text.muted` theme token (may be unresolved at
    // load time, in which case the element falls back to the default fg).
    const mutedFg = context.theme?.text?.muted;

    /**
     * Inserts the suggestion into the focused prompt, then clears it.
     * Returns `true` when the suggestion was consumed (the Tab key is handled);
     * `false` when the prompt is not focused (the key falls back to the host).
     */
    const acceptSuggestion = (): boolean => {
      const text = suggestionText();
      if (!text) return false;
      const focused = context.renderer.currentFocusedRenderable;
      if (!focused) return false;
      // The host prompt exposes insertText() (and, when it is an edit buffer,
      // gotoBufferEnd()); host renderables are not part of the plugin API.
      const target = focused as unknown as {
        insertText?: (text: string) => void;
        gotoBufferEnd?: (options?: { select?: boolean }) => void;
      };
      if (typeof target.insertText !== "function") {
        // The prompt does not have focus: keep the suggestion for later.
        return false;
      }
      dbg("accept: focused=" + focused.constructor?.name);
      clear();
      target.insertText(text);
      target.gotoBufferEnd?.();
      focused.invalidateIntrinsicSize();
      context.renderer.requestRender();
      return true;
    };

    /**
     * Generates the session's suggestion. One LLM call with the config default
     * model in the `low` variant (reduced effort); when the model has no such
     * variant, the server refuses without an LLM call and the call is retried
     * without a variant.
     */
    const generateSuggestion = async (sessionID: string): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const token = genToken;
      setGeneratingFor(sessionID);
      try {
        const conversation = await buildConversation(context, sessionID);
        if (!conversation) return;
        const prompt =
          SYSTEM_PROMPT + "\n\nConversation:\n" + conversation + "\n\nSuggestion:";
        const model = await resolveDefaultModel(context);
        let res: { text?: string } | null = null;
        if (model) {
          try {
            res = await context.client.experimental.generate.text({
              prompt,
              model: { ...model, variant: LOW_VARIANT },
            });
            dbg("generated (variant " + LOW_VARIANT + ")");
          } catch {
            // Variant unavailable (or any other error): retry without variant.
            dbg("variant " + LOW_VARIANT + " failed, retrying without variant");
            res = await context.client.experimental.generate.text({ prompt, model });
            dbg("generated (default variant)");
          }
        } else {
          res = await context.client.experimental.generate.text({ prompt });
          dbg("generated (server default model)");
        }
        const text = cleanSuggestion(res?.text ?? "");
        dbg("generated: " + JSON.stringify(text));
        if (!text) return;
        // The viewed session changed, or a clear happened (new prompt) while
        // generating: drop the stale result.
        if (renderedSessionID !== sessionID || token !== genToken) return;
        setGeneratingFor(null);
        setSuggestionFor(sessionID);
        setSuggestionText(text);
        dbg("suggestion set for " + sessionID + ": " + text);
      } catch {
        // A failed suggestion must never break the TUI.
      } finally {
        if (token === genToken) setGeneratingFor(null);
        inFlight = false;
      }
    };

    // Display: ghost text above the prompt (slot `session.composer.top`,
    // mounted only in the session view, input = { sessionID }).
    const offSlot = context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const sid = input.sessionID ?? "";
        const prev = renderedSessionID;
        renderedSessionID = sid;
        if (sid !== prev) dbg("slot render: session=" + sid);
        return (
          <box
            visible={
              generatingFor() === sid ||
              (suggestionFor() === sid && suggestionText() !== null)
            }
            paddingLeft={1}
          >
            <text fg={mutedFg}>
              {generatingFor() === sid
                ? "Generating suggestion…"
                : "↳ " + (suggestionText() ?? "") + "   ·   Tab"}
            </text>
          </box>
        );
      },
    });

    // Tab → accept the suggestion. `enabled` gates the binding: without an
    // active suggestion the key is not captured and falls back to the normal
    // behavior (prompt autocompletion).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          title: "Accept prompt suggestion",
          group: "Prompt",
          bind: "tab",
          enabled: () => suggestionFor() !== null && suggestionText() !== null,
          run: () => (acceptSuggestion() ? undefined : false),
        },
      ],
    }));

    // End of turn → generate the suggestion (only for the rendered session).
    const offSucceeded = context.data.on("session.execution.succeeded", (event) => {
      const sid = event.data.sessionID;
      if (sid !== renderedSessionID) {
        dbg("succeeded (ignored, not rendered): " + sid);
        return;
      }
      dbg("succeeded (rendered) → generating for " + sid);
      void generateSuggestion(sid);
    });

    // New user prompt → the suggestion is no longer relevant.
    const offEnqueued = context.data.on("session.inbox.enqueued", (event) => {
      const item = event.data.item;
      if (item.type === "user") {
        dbg("new user prompt (clear): " + JSON.stringify(item.payload.text ?? ""));
        clear();
      }
    });

    // Session deleted → the associated suggestion no longer makes sense.
    const offDeleted = context.data.on("session.deleted", (event) => {
      const sid = event.data.sessionID;
      if (sid === suggestionFor()) clear();
    });

    // Cleanup on plugin unload.
    return () => {
      offSlot();
      offSucceeded();
      offEnqueued();
      offDeleted();
    };
  },
});
