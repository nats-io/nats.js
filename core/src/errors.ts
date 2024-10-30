/*
 * Copyright 2024 Synadia Communications, Inc
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

/**
 * Represents an error that is thrown when an invalid subject is encountered.
 * This class extends the built-in Error object.
 *
 * @class
 * @extends Error
 */
export class InvalidSubjectError extends Error {
  constructor(subject: string, options?: ErrorOptions) {
    super(`illegal subject: '${subject}'`, options);
    this.name = "InvalidSubjectError";
  }
}

export class InvalidArgumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidArgumentError";
  }

  static format(name: string, message: string): string {
    return `'${name}' ${message}`;
  }

  static formatMultiple(names: string[], message: string): string {
    names = names.map((n) => `'${n}'`);
    return `${names.join(",")} ${message}`;
  }
}

/**
 * InvalidOperationError is a custom error class that extends the standard Error object.
 * It represents an error that occurs when an invalid operation is attempted on one of
 * objects returned by the API. For example, trying to iterate on an object that was
 * configured with a callback.
 *
 * @class InvalidOperationError
 * @extends {Error}
 *
 * @param {string} message - The error message that explains the reason for the error.
 * @param {ErrorOptions} [options] - Optional parameter to provide additional error options.
 */
export class InvalidOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidOperationError";
  }
}

/**
 * Represents an error indicating that user authentication has expired.
 * This error is typically thrown when a user attempts to access a connection
 * but their authentication credentials have expired.
 */
export class UserAuthenticationExpiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserAuthenticationExpiredError";
  }

  static parse(s: string): UserAuthenticationExpiredError | null {
    const ss = s.toLowerCase();
    if (ss.indexOf("user authentication expired") !== -1) {
      return new UserAuthenticationExpiredError(s);
    }
    return null;
  }
}

/**
 * Represents an error related to authorization issues.
 * Note that these could represent an authorization violation,
 * or that the account authentication configuration has expired,
 * or an authentication timeout.
 */
export class AuthorizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorizationError";
  }

  static parse(s: string): AuthorizationError | null {
    const messages = [
      "authorization violation",
      "account authentication expired",
      "authentication timeout",
    ];

    const ss = s.toLowerCase();

    for (let i = 0; i < messages.length; i++) {
      if (ss.indexOf(messages[i]) !== -1) {
        return new AuthorizationError(s);
      }
    }

    return null;
  }
}

/**
 * Class representing an error thrown when an operation is attempted on a closed connection.
 *
 * This error is intended to signal that a connection-related operation could not be completed
 * because the connection is no longer open or has been terminated.
 *
 * @class
 * @extends Error
 */
export class ClosedConnectionError extends Error {
  constructor() {
    super("closed connection");
    this.name = "ClosedConnectionError";
  }
}

/**
 * The `ConnectionDrainingError` class represents a specific type of error
 * that occurs when a connection is being drained.
 *
 * This error is typically used in scenarios where connections need to be
 * gracefully closed or when they are transitioning to an inactive state.
 *
 * The error message is set to "connection draining" and the error name is
 * overridden to "DrainingConnectionError".
 */
export class DrainingConnectionError extends Error {
  constructor() {
    super("connection draining");
    this.name = "DrainingConnectionError";
  }
}

/**
 * Represents an error that occurs when a network connection fails.
 * Extends the built-in Error class to provide additional context for connection-related issues.
 *
 * @param {string} message - A human-readable description of the error.
 * @param {ErrorOptions} [options] - Optional settings for customizing the error behavior.
 */
export class ConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/**
 * Represents an error encountered during protocol operations.
 * This class extends the built-in `Error` class, providing a specific
 * error type called `ProtocolError`.
 *
 * @param {string} message - A descriptive message describing the error.
 * @param {ErrorOptions} [options] - Optional parameters to include additional details.
 */
export class ProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

/**
 * Class representing an error that occurs during an request operation
 * (such as TimeoutError, or NoRespondersError, or some other error).
 *
 * @extends Error
 */
export class RequestError extends Error {
  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestError";
  }
}

/**
 * TimeoutError is a custom error class that extends the built-in Error class.
 * It is used to represent an error that occurs when an operation exceeds a
 * predefined time limit.
 *
 * @class
 * @extends {Error}
 */
export class TimeoutError extends Error {
  constructor(options?: ErrorOptions) {
    super("timeout", options);
    this.name = "TimeoutError";
  }
}

/**
 * NoRespondersError is an error thrown when no responders (no service is
 * subscribing to the subject) are found for a given subject. This error
 * is typically found as the cause for a RequestError
 *
 * @extends Error
 *
 * @param {string} subject - The subject for which no responders were found.
 * @param {ErrorOptions} [options] - Optional error options.
 */
export class NoRespondersError extends Error {
  subject: string;
  constructor(subject: string, options?: ErrorOptions) {
    super(`no responders: '${subject}'`, options);
    this.subject = subject;
    this.name = "NoResponders";
  }
}

/**
 * Class representing a Permission Violation Error.
 * It provides information about the operation (either "publish" or "subscription")
 * and the subject used for the operation and the optional queue (if a subscription).
 *
 * This error is terminal for a subscription.
 */
export class PermissionViolationError extends Error {
  operation: "publish" | "subscription";
  subject: string;
  queue?: string;

  constructor(
    message: string,
    operation: "publish" | "subscription",
    subject: string,
    queue?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PermissionViolationError";
    this.operation = operation;
    this.subject = subject;
    this.queue = queue;
  }

  static parse(s: string): PermissionViolationError | null {
    const t = s ? s.toLowerCase() : "";
    if (t.indexOf("permissions violation") === -1) {
      return null;
    }
    let operation: "publish" | "subscription" = "publish";
    let subject = "";
    let queue: string | undefined = undefined;
    const m = s.match(/(Publish|Subscription) to "(\S+)"/);
    if (m) {
      operation = m[1].toLowerCase() as "publish" | "subscription";
      subject = m[2];
      if (operation === "subscription") {
        const qm = s.match(/using queue "(\S+)"/);
        if (qm) {
          queue = qm[1];
        }
      }
    }
    return new PermissionViolationError(s, operation, subject, queue);
  }
}

export const errors = {
  AuthorizationError,
  ClosedConnectionError,
  ConnectionError,
  DrainingConnectionError,
  InvalidArgumentError,
  InvalidOperationError,
  InvalidSubjectError,
  NoRespondersError,
  PermissionViolationError,
  ProtocolError,
  RequestError,
  TimeoutError,
  UserAuthenticationExpiredError,
};
