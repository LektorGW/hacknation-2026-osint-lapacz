import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorInDataMode, dataModeStatus, needsLiveConfirmation, resolveMode, runDataModeTag } from '../src/mode.ts';

test('stan przełącznika trybu danych z GET /api/health', () => {
  assert.equal(dataModeStatus(null), null);
  assert.equal(dataModeStatus({ mode: 'live' }), null, 'starsza usługa bez przełącznika');
  assert.deepEqual(dataModeStatus({ mode: 'sandbox', dataMode: 'synthetic', dataModesAvailable: { synthetic: true, live: true, both: true } }), {
    current: 'synthetic',
    available: { synthetic: true, live: true, both: true },
  });
  // Bieżący tryb jest zawsze dostępny, nawet gdy usługa nie poda flag.
  assert.deepEqual(dataModeStatus({ dataMode: 'live' })?.available, { synthetic: false, live: true, both: false });
  assert.equal(dataModeStatus({ dataMode: 'cokolwiek' }), null);
  // Znaczek trybu nadal wynika wyłącznie z pola `mode`.
  assert.equal(resolveMode(false, { mode: 'sandbox', dataMode: 'synthetic' }).mode, 'sandbox');
  assert.equal(resolveMode(true, { mode: 'live', dataMode: 'live' }).mode, 'demo');
});

test('potwierdzenie tylko przy włączaniu prawdziwych źródeł', () => {
  assert.equal(needsLiveConfirmation('synthetic', 'live'), true);
  assert.equal(needsLiveConfirmation('synthetic', 'both'), true);
  assert.equal(needsLiveConfirmation('live', 'both'), false);
  assert.equal(needsLiveConfirmation('both', 'synthetic'), false);
  assert.equal(needsLiveConfirmation('live', 'synthetic'), false);
});

test('znacznik analizy i łączniki w trybie', () => {
  assert.equal(runDataModeTag({ dataMode: 'synthetic' }), 'SANDBOX');
  assert.equal(runDataModeTag({ dataMode: 'live' }), 'LIVE');
  assert.equal(runDataModeTag({ dataMode: 'both' }), 'LIVE');
  assert.equal(runDataModeTag({}), undefined);
  assert.equal(runDataModeTag(undefined), undefined);
  assert.equal(connectorInDataMode('sandbox-gitpub', 'synthetic'), true);
  assert.equal(connectorInDataMode('lab-forum-it', 'live'), false);
  assert.equal(connectorInDataMode('live-github', 'synthetic'), false);
  assert.equal(connectorInDataMode('live-github', 'live'), true);
  assert.equal(connectorInDataMode('corpus', 'synthetic'), true);
  assert.equal(connectorInDataMode('rejestry-publiczne', 'live'), true);
  assert.equal(connectorInDataMode('sandbox-gitpub', 'both'), true);
});
