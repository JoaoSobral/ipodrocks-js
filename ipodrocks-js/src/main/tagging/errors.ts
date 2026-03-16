/**
 * Typed errors for APEv2 tagging and MPC format handling.
 */

export class MpcFormatError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MpcFormatError";
  }
}

export class ApeTagError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ApeTagError";
  }
}

export class ApeKeyError extends ApeTagError {
  constructor(key: string, reason: string) {
    super(`Invalid APEv2 key "${key}": ${reason}`);
    this.name = "ApeKeyError";
  }
}
