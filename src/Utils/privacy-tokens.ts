import { hmacSign } from "./crypto";
import { jidNormalizedUser, isLidUser, isJidUser } from "../WABinary";
import type { SignalDataTypeMap } from "../Types";

/** Single id used with the `nct-salt` key store category. */
export const NCT_SALT_STORE_ID = "account";

/**
 * Defaults aligned with WA Web / Zapo (`WA_TC_TOKEN_DEFAULTS`):
 * 7-day buckets × 4 ≈ ~4 weeks receiver validity window.
 */
export const WA_TC_TOKEN_DEFAULTS = Object.freeze({
  DURATION_S: 604_800,
  NUM_BUCKETS: 4,
  SENDER_DURATION_S: 604_800,
  SENDER_NUM_BUCKETS: 4,
  MAX_DURATION_S: 15_552_000
});

export const computeTokenBucket = (unixTimeS: number, durationS: number) =>
  Math.floor(unixTimeS / durationS);

export const tokenExpirationCutoffS = (
  nowS: number,
  durationS: number,
  numBuckets: number
) => {
  const currentBucket = computeTokenBucket(nowS, durationS);
  return (currentBucket - numBuckets) * durationS;
};

/** True when the receiver `tctoken` timestamp falls before the rolling cutoff. */
export const isTokenExpired = (
  tokenTimestampS: number,
  nowS: number,
  durationS: number = WA_TC_TOKEN_DEFAULTS.DURATION_S,
  numBuckets: number = WA_TC_TOKEN_DEFAULTS.NUM_BUCKETS
) => tokenTimestampS < tokenExpirationCutoffS(nowS, durationS, numBuckets);

/**
 * Sender should re-issue a privacy token when the bucket of the last issue
 * differs from the current bucket (~weekly by default).
 */
export const shouldSendNewToken = (
  senderTimestampS: number,
  nowS: number,
  senderDurationS: number = WA_TC_TOKEN_DEFAULTS.SENDER_DURATION_S
) =>
  computeTokenBucket(senderTimestampS, senderDurationS) !==
  computeTokenBucket(nowS, senderDurationS);

/**
 * Whether a stored receiver tcToken may be attached on outbound stanzas.
 * Missing timestamp is treated as unusable (same as Zapo).
 */
export const isReceiverTcTokenValid = (
  record: TcTokenRecord | undefined | null,
  nowS: number,
  durationS: number = WA_TC_TOKEN_DEFAULTS.DURATION_S,
  numBuckets: number = WA_TC_TOKEN_DEFAULTS.NUM_BUCKETS
): boolean => {
  if (
    !record?.token?.length ||
    record.timestamp == null ||
    record.timestamp === ""
  ) {
    return false;
  }

  const tokenTimestampS = Number(record.timestamp);
  if (!Number.isFinite(tokenTimestampS)) {
    return false;
  }

  return !isTokenExpired(tokenTimestampS, nowS, durationS, numBuckets);
};

/**
 * Derive outbound `<cstoken>` (Baileys / whatsmeow / WA Web NCT):
 * HMAC-SHA256(key = nctSalt, data = utf8(normalized recipient @lid)).
 */
export const generateCsTokenHash = (
  nctSalt: Uint8Array | Buffer,
  recipientLid: string
): Buffer => {
  const lid = jidNormalizedUser(recipientLid) || recipientLid;
  return hmacSign(Buffer.from(lid, "utf8"), Buffer.from(nctSalt), "sha256");
};

export type TcTokenRecord = SignalDataTypeMap["contacts-tc-token"];

/** Preserve senderTimestamp when refreshing a receiver token from inbound. */
export const mergeReceiverTcTokenUpdate = (
  existing: TcTokenRecord | undefined,
  update: { token: Buffer; timestamp?: string }
): TcTokenRecord => ({
  ...(existing || {}),
  token: update.token,
  timestamp: update.timestamp
});

export type LidPnMapping = { pnJid?: string | null; lidJid?: string | null };

const hasTcTokenPayload = (rec: TcTokenRecord | undefined | null) =>
  !!(
    rec?.token?.length ||
    rec?.senderTimestamp != null ||
    rec?.timestamp != null
  );

/**
 * When history includes phoneNumberToLidMappings, store the same tcToken
 * under both JIDs so outbound relay to @lid finds the token.
 */
export const expandTcTokensWithLidPnMappings = (
  tcTokens: { [jid: string]: TcTokenRecord },
  mappings: LidPnMapping[] | null | undefined
): { [jid: string]: TcTokenRecord } => {
  if (!mappings?.length) {
    return tcTokens;
  }

  const out = { ...tcTokens };
  const pnToLid = new Map<string, string>();
  const lidToPn = new Map<string, string>();

  for (const m of mappings) {
    if (!m?.pnJid || !m?.lidJid) {
      continue;
    }

    const pn = jidNormalizedUser(m.pnJid);
    const lid = jidNormalizedUser(m.lidJid);
    if (!pn || !lid) {
      continue;
    }

    pnToLid.set(pn, lid);
    lidToPn.set(lid, pn);
  }

  for (const jid of Object.keys(tcTokens)) {
    const rec = tcTokens[jid];
    if (!hasTcTokenPayload(rec)) {
      continue;
    }

    if (isJidUser(jid)) {
      const lid = pnToLid.get(jid);
      if (lid && !out[lid]) {
        out[lid] = { ...rec };
      }
    } else if (isLidUser(jid)) {
      const pn = lidToPn.get(jid);
      if (pn && !out[pn]) {
        out[pn] = { ...rec };
      }
    }
  }

  return out;
};
