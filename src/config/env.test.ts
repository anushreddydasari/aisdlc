import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  DEFAULT_OPENAI_MODEL,
  isMongoUri,
  loadOpenAiConfig,
  loadConfig,
  loadMigrationConfig,
  loadNeutaraConfig,
  loadWebhookConfig,
  mongoUsername,
  normalizeNeutaraBaseUrl,
  resolveDatabaseName,
  resolveRuntimeMongoUri,
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

describe('resolveDatabaseName', () => {
  const PROD = 'aisdlc';

  it('uses the production database in production', () => {
    const result = resolveDatabaseName({}, 'production', PROD);
    assert.ok(result.ok);
    assert.equal(result.databaseName, PROD);
    assert.equal(result.overridden, false);
  });

  it('IGNORES the override in production', () => {
    // A deployment must not be able to point itself elsewhere through an
    // environment variable, however that variable arrived.
    const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: 'somewhere_else' }, 'production', PROD);
    assert.ok(result.ok);
    assert.equal(result.databaseName, PROD);
    assert.equal(result.overridden, false);
  });

  for (const nodeEnv of ['development', 'test'] as const) {
    it(`applies the override in ${nodeEnv}`, () => {
      const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: 'aisdlc_test' }, nodeEnv, PROD);
      assert.ok(result.ok);
      assert.equal(result.databaseName, 'aisdlc_test');
      assert.equal(result.overridden, true);
    });

    it(`refuses to start in ${nodeEnv} when the override is absent`, () => {
      // No fallback: a local service that silently defaults to `aisdlc`
      // writes test traffic into production, invisibly.
      const result = resolveDatabaseName({}, nodeEnv, PROD);
      assert.ok(!result.ok);
      assert.match(result.reason, /AISDLC_DATABASE_NAME must be set/);
      assert.match(result.reason, /no default outside production/);
    });

    it(`treats a blank override as absent in ${nodeEnv}`, () => {
      assert.ok(!resolveDatabaseName({ AISDLC_DATABASE_NAME: '   ' }, nodeEnv, PROD).ok);
    });

    it(`refuses the production database by name in ${nodeEnv}`, () => {
      const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: PROD }, nodeEnv, PROD);
      assert.ok(!result.ok);
      assert.match(result.reason, /refusing to run outside production/);
    });

    it(`refuses a case variant of the production database in ${nodeEnv}`, () => {
      for (const variant of ['AISDLC', 'Aisdlc', 'aiSDLC']) {
        const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: variant }, nodeEnv, PROD);
        assert.ok(!result.ok, `${variant} was accepted`);
      }
    });
  }

  it('allows a name that merely contains the production name', () => {
    const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: 'aisdlc_local' }, 'development', PROD);
    assert.ok(result.ok);
    assert.equal(result.databaseName, 'aisdlc_local');
  });

  it('trims surrounding whitespace', () => {
    const result = resolveDatabaseName({ AISDLC_DATABASE_NAME: '  aisdlc_test  ' }, 'test', PROD);
    assert.ok(result.ok);
    assert.equal(result.databaseName, 'aisdlc_test');
  });

  it('reports whether the value was overridden, so startup can log it', () => {
    const prod = resolveDatabaseName({}, 'production', PROD);
    assert.ok(prod.ok);
    assert.equal(prod.overridden, false);
    const dev = resolveDatabaseName({ AISDLC_DATABASE_NAME: 'x' }, 'development', PROD);
    assert.ok(dev.ok);
    assert.equal(dev.overridden, true);
  });
});

describe('mongoUsername', () => {
  it('extracts the username and never the password', () => {
    assert.equal(mongoUsername(`mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@cluster0.example.mongodb.net/aisdlc`), 'aisdlc_app');
    assert.equal(mongoUsername(`mongodb://someuser:${FAKE_PASSWORD}@host:27017/db`), 'someuser');
  });

  it('is null when the URI carries no credentials', () => {
    assert.equal(mongoUsername('mongodb://host:27017/db'), null);
  });
});

describe('resolveRuntimeMongoUri', () => {
  const PROD_URI = `mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@cluster0.example.mongodb.net/aisdlc`;
  const TEST_URI = `mongodb+srv://aisdlc-test-app:${FAKE_PASSWORD}@cluster0.example.mongodb.net/aisdlc_test`;

  describe('production', () => {
    it('always uses the production URI (d. production mode remains unchanged)', () => {
      const result = resolveRuntimeMongoUri({}, 'production', PROD_URI);
      assert.ok(result.ok);
      assert.equal(result.uri, PROD_URI);
      assert.equal(result.identity, 'production');
    });

    it('ignores AISDLC_TEST_MONGODB_URI even when present', () => {
      // Production must use ONLY the production configuration, however the
      // test variable arrived in the environment.
      const result = resolveRuntimeMongoUri(
        { AISDLC_TEST_MONGODB_URI: TEST_URI },
        'production',
        PROD_URI,
      );
      assert.ok(result.ok);
      assert.equal(result.uri, PROD_URI);
      assert.equal(result.identity, 'production');
    });
  });

  for (const nodeEnv of ['development', 'test'] as const) {
    describe(nodeEnv, () => {
      it('selects the dedicated test URI (a.)', () => {
        const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: TEST_URI }, nodeEnv, PROD_URI);
        assert.ok(result.ok);
        assert.equal(result.uri, TEST_URI);
        assert.equal(result.identity, 'test');
      });

      it('requires AISDLC_TEST_MONGODB_URI, with no fallback to the production URI', () => {
        const result = resolveRuntimeMongoUri({}, nodeEnv, PROD_URI);
        assert.ok(!result.ok);
        assert.match(result.reason, /AISDLC_TEST_MONGODB_URI must be set/);
      });

      it('treats a blank value as absent', () => {
        const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: '   ' }, nodeEnv, PROD_URI);
        assert.ok(!result.ok);
      });

      it('rejects a malformed test URI', () => {
        const result = resolveRuntimeMongoUri(
          { AISDLC_TEST_MONGODB_URI: 'not-a-uri' },
          nodeEnv,
          PROD_URI,
        );
        assert.ok(!result.ok);
        assert.match(result.reason, /AISDLC_TEST_MONGODB_URI is invalid/);
      });

      it('rejects the production URI/identity when byte-identical (b.)', () => {
        const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: PROD_URI }, nodeEnv, PROD_URI);
        assert.ok(!result.ok);
        assert.match(result.reason, /identical/);
      });

      it('rejects the production identity even behind a different URI tail (b.)', () => {
        // Same username as PROD_URI, different host/db — this is exactly the
        // shape of mistake a full-string comparison alone would miss.
        const sameIdentityDifferentTail = `mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@other-cluster.example.mongodb.net/aisdlc_test`;
        const result = resolveRuntimeMongoUri(
          { AISDLC_TEST_MONGODB_URI: sameIdentityDifferentTail },
          nodeEnv,
          PROD_URI,
        );
        assert.ok(!result.ok);
        assert.match(result.reason, /same identity/);
      });

      it('accepts a genuinely different test identity', () => {
        const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: TEST_URI }, nodeEnv, PROD_URI);
        assert.ok(result.ok);
        assert.equal(result.identity, 'test');
      });
    });
  }

  describe('c. combined with resolveDatabaseName: dev/test requires both a dedicated URI and aisdlc_test', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      it(`${nodeEnv}: the database-name override is still mandatory (existing guarantee, unchanged)`, () => {
        // resolveRuntimeMongoUri and resolveDatabaseName are independent
        // knobs; this asserts the pre-existing database-name guarantee still
        // holds alongside the new credential guarantee.
        const uriResult = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: TEST_URI }, nodeEnv, PROD_URI);
        const dbResult = resolveDatabaseName({}, nodeEnv, 'aisdlc');
        assert.ok(uriResult.ok);
        assert.ok(!dbResult.ok);
      });

      it(`${nodeEnv}: both resolve together for a correctly configured aisdlc_test run`, () => {
        const uriResult = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: TEST_URI }, nodeEnv, PROD_URI);
        const dbResult = resolveDatabaseName({ AISDLC_DATABASE_NAME: 'aisdlc_test' }, nodeEnv, 'aisdlc');
        assert.ok(uriResult.ok);
        assert.ok(dbResult.ok);
        assert.equal(uriResult.identity, 'test');
        assert.equal(dbResult.databaseName, 'aisdlc_test');
      });
    }
  });

  describe('e. secrets are not exposed in logs', () => {
    const uriWithSecret = `mongodb+srv://aisdlc-test-app:${FAKE_PASSWORD}@secret-cluster.example.mongodb.net/aisdlc_test`;

    it('never includes the password in a failure reason', () => {
      for (const scenario of [
        () => resolveRuntimeMongoUri({}, 'development', PROD_URI),
        () => resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: PROD_URI }, 'development', PROD_URI),
        () => resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: 'not-a-uri' }, 'development', PROD_URI),
      ]) {
        const result = scenario();
        assert.ok(!result.ok);
        assert.ok(!result.reason.includes(FAKE_PASSWORD), 'the password reached the failure reason');
      }
    });

    it('never includes the host or a full connection string in a failure reason', () => {
      const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: uriWithSecret }, 'development', uriWithSecret);
      assert.ok(!result.ok);
      assert.ok(!result.reason.includes('secret-cluster'));
      assert.ok(!result.reason.includes('mongodb+srv://'));
    });

    it('never includes a username in a failure reason', () => {
      const sameIdentityDifferentTail = `mongodb+srv://aisdlc_app:${FAKE_PASSWORD}@other.example.mongodb.net/aisdlc_test`;
      const result = resolveRuntimeMongoUri(
        { AISDLC_TEST_MONGODB_URI: sameIdentityDifferentTail },
        'development',
        PROD_URI,
      );
      assert.ok(!result.ok);
      assert.ok(!result.reason.includes('aisdlc_app'), 'the username reached the failure reason');
    });

    it('a successful result never carries the password outside the uri field a caller must already have', () => {
      // The uri field necessarily carries the connection string — callers
      // need it to connect — but nothing else in the result shape should.
      const result = resolveRuntimeMongoUri({ AISDLC_TEST_MONGODB_URI: TEST_URI }, 'development', PROD_URI);
      assert.ok(result.ok);
      assert.deepEqual(Object.keys(result).sort(), ['identity', 'ok', 'uri']);
    });
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

/** An obviously fake key, used to assert it never reaches a message. */
const FAKE_OPENAI_KEY = 'sk-test-not-a-real-key-fixture-value'; // pragma: fixture

describe('loadOpenAiConfig', () => {
  it('resolves with the default model when only the key is set', () => {
    const result = loadOpenAiConfig({ OPENAI_API_KEY: FAKE_OPENAI_KEY });
    assert.ok(result.configured);
    assert.equal(result.config.apiKey, FAKE_OPENAI_KEY);
    assert.equal(result.config.model, DEFAULT_OPENAI_MODEL);
  });

  it('honours an explicit model override', () => {
    const result = loadOpenAiConfig({
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
      OPENAI_MODEL: 'gpt-4o',
    });
    assert.ok(result.configured);
    assert.equal(result.config.model, 'gpt-4o');
  });

  it('reports not configured, rather than throwing, when the key is absent', () => {
    // Absent is a valid state: the Requirements Agent falls back to the
    // deterministic stub instead of refusing to run.
    const result = loadOpenAiConfig({});
    assert.ok(!result.configured);
    assert.match(result.reason, /OPENAI_API_KEY/);
    assert.match(result.reason, /deterministic stub/);
  });

  it('treats a blank key as absent', () => {
    assert.ok(!loadOpenAiConfig({ OPENAI_API_KEY: '   ' }).configured);
  });

  it('trims surrounding whitespace on the model', () => {
    const result = loadOpenAiConfig({
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
      OPENAI_MODEL: '  gpt-4o  ',
    });
    assert.ok(result.configured);
    assert.equal(result.config.model, 'gpt-4o');
  });

  it('never includes the key in the not-configured reason', () => {
    const result = loadOpenAiConfig({ OPENAI_MODEL: 'gpt-4o' });
    assert.ok(!result.configured);
    assert.ok(!result.reason.includes(FAKE_OPENAI_KEY));
  });

  it('ignores variables belonging to other phases', () => {
    const result = loadOpenAiConfig({ ...VALID_ENV, OPENAI_API_KEY: FAKE_OPENAI_KEY });
    assert.ok(result.configured);
    assert.deepEqual(Object.keys(result.config).sort(), ['apiKey', 'model']);
  });
});
