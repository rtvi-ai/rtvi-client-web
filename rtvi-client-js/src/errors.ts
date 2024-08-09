export class VoiceError extends Error {
  readonly status: number | undefined;
  readonly error: unknown | undefined;

  constructor(message?: string) {
    super(message); // Pass the message to the Error constructor
    this.error = { message };
  }
}

export class ConnectionTimeoutError extends VoiceError {
  override readonly status = 500;
  constructor(message?: string | undefined) {
    super(
      message ?? "Bot did not enter ready state within the specified timeout"
    );
  }
}

export class TransportAuthBundleError extends VoiceError {
  override readonly status = 500;
  constructor(message?: string | undefined) {
    super(message ?? "Invalid or malformed auth bundle provided to Transport");
  }
}

export class BotStartError extends VoiceError {
  override readonly status = 400;
  constructor(message?: string | undefined) {
    super(message ?? "Unable to instantiate new bot instance");
  }
}

export class RateLimitError extends VoiceError {
  override readonly status = 429;
  constructor(message?: string | undefined) {
    super(message ?? "Rate limit exceeded");
  }
}

export class AuthenticationError extends VoiceError {
  override readonly status = 500;
  constructor(message?: string | undefined) {
    super(message ?? "Unable to authenticate");
  }
}

export class ConfigUpdateError extends VoiceError {
  override readonly status = 400;
  constructor(message?: string | undefined) {
    super(message ?? "Unable to update configuration");
  }
}
