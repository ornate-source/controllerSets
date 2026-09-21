// The auth surface, in one place.
export { createAuthRouter, AUTH_ROUTES } from "./router.js";
export { requireAuth, requireRole } from "./middleware.js";
export { buildAuthConfig, identifier } from "./config.js";
export { hashPassword, verifyPassword } from "./password.js";
export { signToken, verifyToken, durationToSeconds } from "./token.js";
export { generateOtp, hashOtp, otpMatches } from "./otp.js";
export { BUILT_IN_PROVIDERS } from "./providers/index.js";
export { publicUser } from "./account.js";
export { DEFAULT_TEMPLATES, interpolate } from "./delivery.js";
