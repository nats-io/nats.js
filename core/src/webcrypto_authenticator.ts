/*
 * Copyright 2026 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { nkeys } from "./nkeys.ts";
import type { AsyncAuthenticator, JwtAuth, TokenAuth } from "./core.ts";

// An nkey is base32( prefix byte, 32 public key bytes, CRC16-XMODEM of those, little endian ).
// "@nats-io/nkeys" only exposes encoders for keys it generates itself, not for a public key
// that already exists as raw bytes, which is what WebCrypto hands out, so the (small) text
// format is written out here.
const NKEY_USER_PREFIX_BYTE = 20 << 3; // base32-encodes to a leading "U"
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Returns the NATS user nkey text ("U...") for the public half of a WebCrypto
 * Ed25519 key pair. This is the value that belongs in a user JWT's `sub`,
 * and that {@link webCryptoJwtAuthenticator} presents as `nkey` at connect.
 *
 * The key pair must come from `crypto.subtle.generateKey()`: the public key
 * of a generated pair can always be exported, even if the pair was created
 * non-extractable. A public key that was imported (`importKey()`) may not be
 * exportable.
 *
 * @param publicKey - the `publicKey` of a WebCrypto Ed25519 `CryptoKeyPair`
 * @returns the user nkey, for example "UABC...XYZ"
 */
export async function nkeyFromWebCryptoPublicKey(
  publicKey: CryptoKey,
): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const body = new Uint8Array(1 + raw.length + 2);
  body[0] = NKEY_USER_PREFIX_BYTE;
  body.set(raw, 1);
  const checksum = crc16(body.subarray(0, 1 + raw.length));
  new DataView(body.buffer).setUint16(1 + raw.length, checksum, true);
  return base32(body);
}

/**
 * Options for {@link webCryptoJwtAuthenticator}.
 */
export interface WebCryptoJwtAuthenticatorOptions {
  /**
   * An Ed25519 key pair made by `crypto.subtle.generateKey()`. The private
   * key can be (and in a browser, should be) non-extractable: it is only
   * ever used to sign the server's nonce. Keys made by `importKey()` are
   * not supported.
   */
  keyPair: CryptoKeyPair;
  /**
   * The user JWT, whose `sub` is this key pair's public key (see
   * {@link nkeyFromWebCryptoPublicKey}). A function is called on every
   * connect, so a JWT you renew is the one presented on a reconnect.
   */
  jwt: string | (() => string);
  /**
   * An optional `auth_token` to send with the JWT, for a server-side
   * authorization callout that wants one (for example an access token). A
   * function is called on every connect.
   */
  authToken?: string | (() => string);
}

/**
 * Returns an {@link AsyncAuthenticator} for a user JWT bound to a WebCrypto
 * Ed25519 key pair: it signs the server's connection nonce with the pair's
 * private key and presents the JWT, the public key (as an nkey) and the
 * signature. The private key never leaves WebCrypto, so this works with a
 * non-extractable key, which is the reason {@link AsyncAuthenticator}
 * exists: `crypto.subtle.sign()` is asynchronous.
 *
 * This is the recommended way to authenticate with a WebCrypto key. Keys
 * made by `importKey()` are not supported: use a pair from `generateKey()`
 * (see {@link WebCryptoJwtAuthenticatorOptions.keyPair}). Errors
 * from WebCrypto (a key of the wrong algorithm, or one that cannot sign) are
 * not caught: they close the connection attempt with WebCrypto's own error.
 *
 * The same warning as for any {@link AsyncAuthenticator} applies: the server
 * waits 2 seconds by default for the CONNECT. A key that asks the user for
 * presence or a biometric can take longer.
 *
 * @example
 * ```ts
 * const keyPair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
 * const nkey = await nkeyFromWebCryptoPublicKey(keyPair.publicKey);
 * const jwt = await mintUserJwtFor(nkey); // your service signs a user JWT with sub = nkey
 * const nc = await wsconnect({
 *   servers: "wss://nats.example.com",
 *   asyncAuthenticator: webCryptoJwtAuthenticator({ keyPair, jwt }),
 * });
 * ```
 */
export function webCryptoJwtAuthenticator(
  opts: WebCryptoJwtAuthenticatorOptions,
): AsyncAuthenticator {
  const { keyPair, jwt, authToken } = opts;
  let nkey: Promise<string> | undefined;
  return async (nonce?: string): Promise<JwtAuth & Partial<TokenAuth>> => {
    nkey ??= nkeyFromWebCryptoPublicKey(keyPair.publicKey);
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(nonce ?? ""),
    );
    const auth: JwtAuth & Partial<TokenAuth> = {
      jwt: typeof jwt === "function" ? jwt() : jwt,
      nkey: await nkey,
      sig: nkeys.encode(new Uint8Array(signature)),
    };
    if (authToken !== undefined) {
      auth.auth_token = typeof authToken === "function"
        ? authToken()
        : authToken;
    }
    return auth;
  };
}
