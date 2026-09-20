export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

/**
 * How a password account's openId is built: `password:<username>`.
 *
 * Named here rather than written out at each site because it is now read in two places and the
 * pair has to agree - registration writes it, and account lookup recovers the username from it.
 */
export const PASSWORD_OPEN_ID_PREFIX = "password:";
