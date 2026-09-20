import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  isMongoUri,
  loadConfig,
  loadMigrationConfig,
  loadNeutaraConfig,
  loadWebhookConfig,
  normalizeNeutaraBaseUrl,
} from './env.ts';

/** A syntactically valid URI with an obvious fake password, for leak assertions. */
const FAKE_PASSWORD = 'p4ssw0rd-should-never-be-logged';
const VALID_URI = `mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@cluster0.example.mongodb.net/aisdlc?retryWrites=true&w=majority`;

const VALID_ENV = {
  AISDLC_MONGODB_URI: VALID_URI,
  AISDLC_PORT: '8090',
  NODE_ENV: 'development',
} as const;

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.mongodbUri, VALID_URI);
    assert.equal(config.port, 8090);
    assert.equal(config.nodeEnv, 'development');
  });

  it('accepts a plain mongodb:// URI as well as mongodb+srv://', () => {
    const config = loadConfig({ ...VALID_ENV, AISDLC_MONGODB_URI: 'mongodb://localhost:27017/aisdlc' });
    assert.equal(config.port, 8090);
  });

  it('throws ConfigError naming a missing variable', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, AISDLC_MONGODB_URI: undefined }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.deepEqual(error.variables, ['AISDLC_MONGODB_URI']);
        assert.match(error.message, /AISDLC_MONGODB_URI is not set/);
        return true;
      },
    );
  });

  it('treats an empty value as missing', () => {
    // This is the current state of the local .env: `AISDLC_MONGODB_URI=`.
    assert.throws(
      () => loadConfig({ ...VALID_ENV, AISDLC_MONGODB_URI: '' }),
      (error: unknown) => error instanceof ConfigError && error.variables.includes('AISDLC_MONGODB_URI'),
    );
  });

  it('treats a whitespace-only value as missing', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, AISDLC_PORT: '   ' }),
      (error: unknown) => error instanceof ConfigError && error.variables.includes('AISDLC_PORT'),
    );
  });

  it('reports every fault at once rather than the first', () => {
    assert.throws(
      () => loadConfig({}),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.deepEqual([...error.variables].sort(), [
          'AISDLC_MONGODB_URI',
          'AISDLC_PORT',
          'NODE_ENV',
        ]);
        return true;
      },
    );
  });

  it('never includes a variable value in the error message', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, AISDLC_MONGODB_URI: `postgres://user:${FAKE_PASSWORD}@host/db` }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes(FAKE_PASSWORD), 'error message leaked the value');
        assert.ok(!error.message.includes('postgres://'), 'error message quoted the value back');
        assert.match(error.message, /AISDLC_MONGODB_URI is invalid/);
        return true;
      },
    );
  });

  describe('AISDLC_PORT', () => {
    for (const bad of ['0', '65536', '-1', '8090.5', 'http', '0x1f', '1e3', '8090abc']) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        assert.throws(
          () => loadConfig({ ...VALID_ENV, AISDLC_PORT: bad }),
          (error: unknown) => error instanceof ConfigError && error.variables.includes('AISDLC_PORT'),
        );
      });
    }

    for (const good of ['1', '80', '8090', '65535']) {
      it(`accepts ${good}`, () => {
        assert.equal(loadConfig({ ...VALID_ENV, AISDLC_PORT: good }).port, Number(good));
      });
    }
  });

  describe('NODE_ENV', () => {
    for (const good of ['development', 'test', 'production'] as const) {
      it(`accepts ${good}`, () => {
        assert.equal(loadConfig({ ...VALID_ENV, NODE_ENV: good }).nodeEnv, good);
      });
    }

    it('rejects anything else', () => {
      assert.throws(
        () => loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' }),
        (error: unknown) => error instanceof ConfigError && error.variables.includes('NODE_ENV'),
      );
    });
  });

  it('ignores variables belonging to later phases', () => {
    // A Phase 0 checkout must start without NEUTARA_* or OPERATOR_TOKEN set.
    const config = loadConfig(VALID_ENV);
    assert.equal(config.port, 8090);
  });
});

describe('loadMigrationConfig', () => {
  it('reads the migration URI', () => {
    const config = loadMigrationConfig({ AISDLC_MONGODB_MIGRATION_URI: VALID_URI });
    assert.equal(config.mongodbMigrationUri, VALID_URI);
  });

  it('does not accept the runtime URI as a substitute', () => {
    assert.throws(
      () => loadMigrationConfig({ AISDLC_MONGODB_URI: VALID_URI }),
      (error: unknown) =>
        error instanceof ConfigError && error.variables.includes('AISDLC_MONGODB_MIGRATION_URI'),
    );
  });
});

describe('isMongoUri', () => {
  it('accepts Atlas SRV and standard forms', () => {
    assert.ok(isMongoUri('mongodb+srv://u:p@host/db'));
    assert.ok(isMongoUri('mongodb://host:27017'));
  });

  it('rejects other schemes and malformed values', () => {
    assert.ok(!isMongoUri('postgres://host/db'));
    assert.ok(!isMongoUri('mongodb+srv://'));
    assert.ok(!isMongoUri('cluster0.example.mongodb.net'));
    assert.ok(!isMongoUri(''));
  });
});

describe('privilege separation between the two Atlas users', () => {
  const shared = {
    ...VALID_ENV,
    AISDLC_MONGODB_MIGRATION_URI: VALID_URI, // identical to AISDLC_MONGODB_URI
  };

  it('refuses to start the service when both URIs are identical', () => {
    // Pasting the migrator string into both silently gives the service
    // collMod and remove rights, defeating the append-only audit log.
    assert.throws(
      () => loadConfig(shared),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.deepEqual([...error.variables].sort(), [
          'AISDLC_MONGODB_MIGRATION_URI',
          'AISDLC_MONGODB_URI',
        ]);
        assert.match(error.message, /identical/);
        return true;
      },
    );
  });

  it('refuses to run the migration when both URIs are identical', () => {
    assert.throws(
      () => loadMigrationConfig(shared),
      (error: unknown) => error instanceof ConfigError && error.message.includes('identical'),
    );
  });

  it('does not leak the shared URI in the error message', () => {
    assert.throws(
      () => loadConfig(shared),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes(FAKE_PASSWORD));
        assert.ok(!error.message.includes('cluster0'));
        return true;
      },
    );
  });

  it('accepts two different URIs', () => {
    const config = loadConfig({
      ...VALID_ENV,
      AISDLC_MONGODB_MIGRATION_URI: VALID_URI.replace('aisdlc_app', 'aisdlc_migrator'),
    });
    assert.equal(config.mongodbUri, VALID_URI);
  });

  it('does not fire when only one of the two is set', () => {
    // The service must start in Phase 0 with no migration URI configured.
    assert.equal(loadConfig(VALID_ENV).port, 8090);
  });
});

describe('loadWebhookConfig', () => {
  it('reads the webhook secret when present', () => {
    assert.equal(loadWebhookConfig({ NEUTARA_WEBHOOK_SECRET: 'whsec_x' }).webhookSecret, 'whsec_x');
  });

  it('reports an absent secret rather than throwing', () => {
    // The service must start without it: a Phase 0-2 checkout has no webhook
    // configured, and /ingest answering 401 is a valid state.
    assert.equal(loadWebhookConfig({}).webhookSecret, undefined);
  });

  it('treats a blank secret as absent', () => {
    assert.equal(loadWebhookConfig({ NEUTARA_WEBHOOK_SECRET: '   ' }).webhookSecret, undefined);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(loadWebhookConfig({ NEUTARA_WEBHOOK_SECRET: '  s  ' }).webhookSecret, 's');
  });

  it('is not required by loadConfig, so the service still starts without it', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.port, 8090);
  });

  it('ignores the production database URIs entirely', () => {
    const result = loadWebhookConfig({ ...VALID_ENV, NEUTARA_WEBHOOK_SECRET: 'whsec_x' });
    assert.deepEqual(Object.keys(result), ['webhookSecret']);
  });
});

/** An obviously fake token, used to assert it never reaches a message. */
const FAKE_TOKEN = 'nta_not_a_real_token_value'; // pragma: fixture
const NEUTARA_ENV = {
  NEUTARA_API_BASE_URL: 'https://neutara.example.com',
  NEUTARA_API_TOKEN: FAKE_TOKEN,
} as const;

describe('normalizeNeutaraBaseUrl', () => {
  it('accepts a plain HTTPS origin unchanged', () => {
    const result = normalizeNeutaraBaseUrl('https://neutara.example.com');
    assert.ok(result.ok);
    assert.equal(result.baseUrl, 'https://neutara.example.com');
  });

  it('accepts http, for a local instance', () => {
    const result = normalizeNeutaraBaseUrl('http://localhost:8080');
    assert.ok(result.ok);
    assert.equal(result.baseUrl, 'http://localhost:8080');
  });

  it('strips a trailing slash', () => {
    // Otherwise the client builds `https://host//api/issues/KEY`.
    for (const value of ['https://neutara.example.com/', 'https://neutara.example.com//']) {
      const result = normalizeNeutaraBaseUrl(value);
      assert.ok(result.ok, `rejected ${value}`);
      assert.equal(result.baseUrl, 'https://neutara.example.com');
    }
  });

  it('rejects a base URL that already carries /api', () => {
    // The client appends `/api/issues/{key}` itself, so this would produce
    // `/api/api/issues/...` and a 404 that looks like a missing ticket
    // rather than a configuration error.
    for (const value of [
      'https://neutara.example.com/api',
      'https://neutara.example.com/api/',
      'https://neutara.example.com/api/issues',
    ]) {
      const result = normalizeNeutaraBaseUrl(value);
      assert.ok(!result.ok, `accepted ${value}`);
      assert.match(result.reason, /origin with no path/);
    }
  });

  it('rejects any other path component', () => {
    for (const value of ['https://neutara.example.com/v1', 'https://neutara.example.com/a/b']) {
      assert.ok(!normalizeNeutaraBaseUrl(value).ok, `accepted ${value}`);
    }
  });

  it('rejects a query string', () => {
    const result = normalizeNeutaraBaseUrl('https://neutara.example.com?token=x');
    assert.ok(!result.ok);
    assert.match(result.reason, /query or fragment/);
  });

  it('rejects a fragment', () => {
    const result = normalizeNeutaraBaseUrl('https://neutara.example.com#section');
    assert.ok(!result.ok);
    assert.match(result.reason, /query or fragment/);
  });

  it('rejects an unsupported scheme', () => {
    for (const value of [
      'ftp://neutara.example.com',
      'ws://neutara.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      const result = normalizeNeutaraBaseUrl(value);
      assert.ok(!result.ok, `accepted ${value}`);
      assert.match(result.reason, /http or https/);
    }
  });

  it('rejects a value that is not a URL at all', () => {
    for (const value of ['neutara.example.com', 'not a url', '', '   ']) {
      const result = normalizeNeutaraBaseUrl(value);
      assert.ok(!result.ok, `accepted ${JSON.stringify(value)}`);
      assert.match(result.reason, /not a valid URL/);
    }
  });

  it('names the variable in every rejection, so the fix is obvious', () => {
    for (const value of ['nope', 'ftp://x.example.com', 'https://x.example.com/api', 'https://x.example.com?a=1']) {
      const result = normalizeNeutaraBaseUrl(value);
      assert.ok(!result.ok);
      assert.match(result.reason, /NEUTARA_API_BASE_URL/);
    }
  });
});

describe('loadNeutaraConfig', () => {
  it('resolves when both variables are configured', () => {
    const result = loadNeutaraConfig(NEUTARA_ENV);
    assert.ok(result.configured);
    assert.equal(result.config.baseUrl, 'https://neutara.example.com');
    assert.equal(result.config.token, FAKE_TOKEN);
  });

  it('normalises the base URL on the way through', () => {
    const result = loadNeutaraConfig({ ...NEUTARA_ENV, NEUTARA_API_BASE_URL: 'https://neutara.example.com/' });
    assert.ok(result.configured);
    assert.equal(result.config.baseUrl, 'https://neutara.example.com');
  });

  it('reports a missing base URL rather than throwing', () => {
    // Absent is a valid state: the service runs without enrichment instead
    // of refusing to start.
    const result = loadNeutaraConfig({ NEUTARA_API_TOKEN: FAKE_TOKEN });
    assert.ok(!result.configured);
    assert.match(result.reason, /NEUTARA_API_BASE_URL/);
    assert.match(result.reason, /enrichment is disabled/);
  });

  it('reports a missing token rather than throwing', () => {
    const result = loadNeutaraConfig({ NEUTARA_API_BASE_URL: 'https://neutara.example.com' });
    assert.ok(!result.configured);
    assert.match(result.reason, /NEUTARA_API_TOKEN/);
  });

  it('names both variables when neither is set', () => {
    const result = loadNeutaraConfig({});
    assert.ok(!result.configured);
    assert.match(result.reason, /NEUTARA_API_BASE_URL/);
    assert.match(result.reason, /NEUTARA_API_TOKEN/);
  });

  it('treats a blank value as missing', () => {
    for (const override of [{ NEUTARA_API_BASE_URL: '   ' }, { NEUTARA_API_TOKEN: '  ' }]) {
      assert.ok(!loadNeutaraConfig({ ...NEUTARA_ENV, ...override }).configured);
    }
  });

  it('trims surrounding whitespace on the token', () => {
    const result = loadNeutaraConfig({ ...NEUTARA_ENV, NEUTARA_API_TOKEN: `  ${FAKE_TOKEN}  ` });
    assert.ok(result.configured);
    assert.equal(result.config.token, FAKE_TOKEN);
  });

  it('propagates a base-URL rejection', () => {
    const result = loadNeutaraConfig({ ...NEUTARA_ENV, NEUTARA_API_BASE_URL: 'https://x.example.com/api' });
    assert.ok(!result.configured);
    assert.match(result.reason, /origin with no path/);
  });

  it('never includes the token in a failure reason', () => {
    // Reasons are logged at startup; a token in one would be a leak.
    for (const override of [
      { NEUTARA_API_BASE_URL: 'not-a-url' },
      { NEUTARA_API_BASE_URL: 'ftp://x.example.com' },
      { NEUTARA_API_BASE_URL: 'https://x.example.com/api' },
      { NEUTARA_API_BASE_URL: '' },
    ]) {
      const result = loadNeutaraConfig({ ...NEUTARA_ENV, ...override });
      assert.ok(!result.configured);
      assert.ok(!result.reason.includes(FAKE_TOKEN), 'the token reached the failure reason');
      assert.ok(!result.reason.includes('nta_'), 'a token prefix reached the failure reason');
    }
  });

  it('never echoes the base URL value back either', () => {
    // The host is not a secret, but quoting input into an error is the habit
    // that leaks the ones that are.
    const result = loadNeutaraConfig({ ...NEUTARA_ENV, NEUTARA_API_BASE_URL: 'https://secret-host.example.com/api' });
    assert.ok(!result.configured);
    assert.ok(!result.reason.includes('secret-host'));
  });

  it('ignores variables belonging to other phases', () => {
    const result = loadNeutaraConfig({
      ...NEUTARA_ENV,
      ...VALID_ENV,
      NEUTARA_WEBHOOK_SECRET: 'whsec_x',
      OPERATOR_TOKEN: 'op_x',
    });
    assert.ok(result.configured);
    assert.deepEqual(Object.keys(result.config).sort(), ['baseUrl', 'token']);
  });
});
