import * as z from "zod/v4";

const requestId = z.uuid();
const account = z.object({
  credentialId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2048),
  name: z.string().min(1).max(500),
}).strict();
const extensionProvider = z.object({
  id: z.string().regex(/^[a-p]{32}$/),
  name: z.string().min(1).max(80),
}).strict();

/** Only trusted launcher UI receives these ephemeral WebAuthn prompts. */
export const BrowserAuthenticationPromptStateSchema = z.object({
  id: requestId,
  kind: z.enum(["method", "touch", "verification", "pin", "account", "qr"]),
  origin: z.url(),
  relyingPartyId: z.string().min(1).max(253),
  reason: z.enum(["set", "change", "challenge", "unknown"]).optional(),
  error: z.enum(["none", "internal-uv-locked", "wrong-pin", "too-short", "invalid-characters", "same-as-current", "unknown"]).optional(),
  minPinLength: z.number().int().min(1).max(127).optional(),
  attempts: z.number().int().min(0).max(100).optional(),
  qrDataUrl: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(2_000_000).nullable(),
  bluetoothStatus: z.enum(["on", "off", "permission-denied", "permission-required", "le-unavailable", "unknown"]).optional(),
  hybridProgress: z.enum(["phone-connected", "bluetooth-seen", "ready"]).optional(),
  canPowerOnBluetooth: z.boolean().optional(),
  securityKeyAvailable: z.boolean().optional(),
  phoneAvailable: z.boolean().optional(),
  platformAvailable: z.boolean().optional(),
  extensionProviders: z.array(extensionProvider).max(10),
  verificationAttempts: z.number().int().min(0).max(100).optional(),
  accounts: z.array(account).max(100).nullable(),
}).strict();

/** A reply is accepted only from the currently visible, launcher-owned prompt window. */
export const BrowserAuthenticationReplySchema = z.discriminatedUnion("action", [
  z.object({ id: requestId, action: z.literal("cancel") }).strict(),
  z.object({ id: requestId, action: z.literal("submit-pin"), pin: z.string().min(1).max(127) }).strict(),
  z.object({ id: requestId, action: z.literal("select-account"), credentialId: account.shape.credentialId }).strict(),
  z.object({ id: requestId, action: z.literal("use-security-key") }).strict(),
  z.object({ id: requestId, action: z.literal("use-phone") }).strict(),
  z.object({ id: requestId, action: z.literal("use-device") }).strict(),
  z.object({ id: requestId, action: z.literal("use-extension"), extensionId: extensionProvider.shape.id }).strict(),
  z.object({ id: requestId, action: z.literal("choose-method") }).strict(),
  z.object({ id: requestId, action: z.literal("power-on-bluetooth") }).strict(),
  z.object({ id: requestId, action: z.literal("request-bluetooth-permission") }).strict(),
]);

export type BrowserAuthenticationPromptState = z.infer<typeof BrowserAuthenticationPromptStateSchema>;
export type BrowserAuthenticationReply = z.infer<typeof BrowserAuthenticationReplySchema>;
