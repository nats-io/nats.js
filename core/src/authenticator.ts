/*
 * Copyright 2020-2023 The NATS Authors
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
import { TD, TE } from "./encoders.ts";
import type {
  Auth,
  Authenticator,
  JwtAuth,
  NKeyAuth,
  NoAuth,
  TokenAuth,
  UserPass,
} from "./core.ts";

export function multiAuthenticator(authenticators: Authenticator[]) {
  return (nonce?: string): Auth => {
    let auth: Partial<NoAuth & TokenAuth & UserPass & NKeyAuth & JwtAuth> = {};
    authenticators.forEach((a) => {
      const args = a(nonce) || {};
      auth = Object.assign(auth, args);
    });
    return auth as Auth;
  };
}

export function noAuthFn(): Authenticator {
  return (): NoAuth => {
    return;
  };
}

/**
 * Returns a user/pass authenticator for the specified user and optional password
 * @param { string | () => string } user
 * @param {string | () => string } pass
 * @return {UserPass}
 */
export function usernamePasswordAuthenticator(
  user: string | (() => string),
  pass?: string | (() => string),
): Authenticator {
  return (): UserPass => {
    const u = typeof user === "function" ? user() : user;
    const p = typeof pass === "function" ? pass() : pass;
    return { user: u, pass: p };
  };
}

/**
 * Returns a token authenticator for the specified token
 * @param { string | () => string } token
 * @return {TokenAuth}
 */
export function tokenAuthenticator(
  token: string | (() => string),
): Authenticator {
  return (): TokenAuth => {
    const auth_token = typeof token === "function" ? token() : token;
    return { auth_token };
  };
}

/**
 * Returns an Authenticator that returns a NKeyAuth based that uses the
 * specified seed or function returning a seed.
 * @param {Uint8Array | (() => Uint8Array)} seed - the nkey seed
 * @return {NKeyAuth}
 */
export function nkeyAuthenticator(
  seed?: Uint8Array | (() => Uint8Array),
): Authenticator {
  return (nonce?: string): NKeyAuth => {
    const s = typeof seed === "function" ? seed() : seed;
    const kp = s ? nkeys.fromSeed(s) : undefined;
    const nkey = kp ? kp.getPublicKey() : "";
    const challenge = TE.encode(nonce || "");
    const sigBytes = kp !== undefined && nonce ? kp.sign(challenge) : undefined;
    const sig = sigBytes ? nkeys.encode(sigBytes) : "";
    return { nkey, sig };
  };
}

/**
 * Returns an Authenticator function that returns a JwtAuth.
 * If a seed is provided, the public key, and signature are
 * calculated.
 *
 * @param {string | ()=>string} ajwt - the jwt
 * @param {Uint8Array | ()=> Uint8Array } seed - the optional nkey seed
 * @return {Authenticator}
 */
export function jwtAuthenticator(
  ajwt: string | (() => string),
  seed?: Uint8Array | (() => Uint8Array),
): Authenticator {
  return (
    nonce?: string,
  ): JwtAuth => {
    const jwt = typeof ajwt === "function" ? ajwt() : ajwt;
    const fn = nkeyAuthenticator(seed);
    const { nkey, sig } = fn(nonce) as NKeyAuth;
    return { jwt, nkey, sig };
  };
}

/**
 * Returns an Authenticator function that returns a JwtAuth.
 * This is a convenience Authenticator that parses the
 * specified creds and delegates to the jwtAuthenticator.
 * @param {Uint8Array | () => Uint8Array } creds - the contents of a creds file or a function that returns the creds
 * @returns {JwtAuth}
 */
export function credsAuthenticator(
  creds: Uint8Array | (() => Uint8Array),
): Authenticator {
  const fn = typeof creds !== "function" ? () => creds : creds;
  const parse = () => {
    const CREDS =
      /\s*(?:(?:[-]{3,}[^\n]*[-]{3,}\n)(.+)(?:\n\s*[-]{3,}[^\n]*[-]{3,}\n))/ig;
    const s = TD.decode(fn());
    // get the JWT
    let m = CREDS.exec(s);
    if (!m) {
      throw new Error("unable to parse credentials");
    }
    const jwt = m[1].trim();
    // get the nkey
    m = CREDS.exec(s);
    if (!m) {
      throw new Error("unable to parse credentials");
    }
    const seed = TE.encode(m[1].trim());

    return { jwt, seed };
  };

  const jwtFn = () => {
    const { jwt } = parse();
    return jwt;
  };
  const nkeyFn = () => {
    const { seed } = parse();
    return seed;
  };

  return jwtAuthenticator(jwtFn, nkeyFn);
}
