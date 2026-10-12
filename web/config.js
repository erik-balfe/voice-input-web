// Public configuration (no secrets). The client id is the public Grok CLI client used by
// erik-balfe/voice-input-android; tokens are obtained per user and kept in IndexedDB.
export const CONFIG = {
  authProxy: "https://agent-host.tailc5f02e.ts.net/xai-auth", // forwards only device/code + token to auth.x.ai
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  refreshSkewSec: 3600, // refresh 1 h before JWT exp (same as Android)
  sttUrl: "https://api.x.ai/v1/stt",
  sttModel: "grok-voice-transcribe-2.0",
  responsesUrl: "https://api.x.ai/v1/responses",
  defaultCleanupModel: "grok-4.20-0309-non-reasoning",
  defaultCleanupPrompt:
    "You clean up dictated text that will be sent as a chat message (Telegram, WhatsApp). " +
    "Fix speech-recognition mistakes, typos, punctuation and capitalization. Remove filler words, " +
    "false starts and repetitions. Make it concise and natural while keeping the meaning, tone, " +
    "person and language of the original (never translate). Do not add anything, do not answer " +
    "questions contained in the text, no quotes, no comments. Output only the cleaned text.",
  maxHistory: 50,
};
