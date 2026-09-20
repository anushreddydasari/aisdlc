import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  isMongoUri,
  loadConfig,
  loadMigrationConfig,
  loadWebhookConfig,
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
