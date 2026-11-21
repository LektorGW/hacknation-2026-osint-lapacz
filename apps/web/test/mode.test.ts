import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSyntheticChain, isSyntheticSource, modeText, resolveMode, syntheticConnectorIds } from '../src/mode.ts';

// ---------- Znaczek trybu ----------

test('wbudowany zastępnik API to zawsze DEMO, bez względu na odpowiedź usługi', () => {
  assert.equal(resolveMode(true, null).mode, 'demo');
  assert.equal(resolveMode(true, { mode: 'live' }).mode, 'demo');
  assert.equal(modeText(resolveMode(true, null)), 'DEMO — dane przykładowe wbudowane w interfejs, nie pochodzą ze źródeł');
});

test('tryb LIVE i SANDBOX pochodzi wyłącznie z pola mode w /api/health', () => {
  assert.equal(resolveMode(false, { status: 'ok', mode: 'live' }).mode, 'live');
  assert.equal(resolveMode(false, { status: 'ok', mode: 'sandbox' }).mode, 'sandbox');
  assert.equal(resolveMode(false, { mode: ' SANDBOX ' }).mode, 'sandbox');
  assert.equal(modeText(resolveMode(false, { mode: 'sandbox' })), 'SANDBOX — źródła i blockchain piaskownicy (dane syntetyczne)');
  assert.equal(modeText(resolveMode(false, { mode: 'live' })), 'LIVE — publiczne źródła');
});

test('brak pola, nieznana wartość albo błąd usługi to tryb nieustalony — nigdy domyślne LIVE', () => {
  for (const health of [null, undefined, {}, { status: 'ok' }, { mode: 'demo' }, { mode: 'produkcja' }, { mode: 1 }, 'live']) {
    assert.equal(resolveMode(false, health).mode, 'unknown', JSON.stringify(health));
  }
  assert.equal(modeText(resolveMode(false, null)), 'tryb nieustalony');
});

// ---------- Dane syntetyczne ----------

test('łączniki piaskownicy i laboratorium są rozpoznawane po przedrostku identyfikatora', () => {
  assert.ok(isSyntheticSource({ connectorId: 'sandbox-forum' }));
  assert.ok(isSyntheticSource({ connectorId: 'sandbox-archiwum' }));
  assert.ok(isSyntheticSource({ connectorId: 'lab-social-x' }));
  assert.ok(!isSyntheticSource({ connectorId: 'github' }));
  assert.ok(!isSyntheticSource({ connectorId: 'wayback' }));
});

test('usługi syntetyczne są rozpoznawane po nazwie usługi i po adresie publikacji', () => {
  assert.ok(isSyntheticSource({ service: 'forum.sandbox' }));
  assert.ok(isSyntheticSource({ service: 'olx.lab.test' }));
  assert.ok(isSyntheticSource({ url: 'https://forum.sandbox/watek/12' }));
  assert.ok(isSyntheticSource({ url: 'http://localhost:4100/explorer/address/abc' }), 'lokalny eksplorator piaskownicy');
  assert.ok(isSyntheticSource({ network: 'lab' }));
  assert.ok(!isSyntheticSource({ service: 'github.com', url: 'https://github.com/ktos' }));
  assert.ok(!isSyntheticSource({ service: 'sandbox.example.com', url: 'https://sandboxgame.com/x' }), 'słowo „sandbox” w środku nazwy nie wystarcza');
  assert.ok(!isSyntheticSource({ url: 'to nie jest adres' }));
  assert.ok(!isSyntheticSource({}));
});

test('flaga łącznika z /api/health oznacza ślad jako syntetyczny także bez przedrostka', () => {
  const flagged = syntheticConnectorIds({ connectors: [{ id: 'Testowy', synthetic: true }, { id: 'github', synthetic: false }, { id: 'piaskownica-2', mode: 'sandbox' }] });
  assert.deepEqual([...flagged].sort(), ['piaskownica-2', 'testowy']);
  assert.ok(isSyntheticSource({ connectorId: 'testowy' }, flagged));
  assert.ok(!isSyntheticSource({ connectorId: 'github' }, flagged));
  assert.deepEqual([...syntheticConnectorIds({ connectors: { 'sandbox-forum': 'sandbox', github: 'live', lab: { synthetic: true } } })].sort(), ['lab', 'sandbox-forum']);
  assert.equal(syntheticConnectorIds(null).size, 0);
  assert.equal(syntheticConnectorIds({ connectors: 'tak' }).size, 0);
});

test('dane blockchain z piaskownicy albo sieci laboratoryjnej są oznaczane jako syntetyczne', () => {
  assert.ok(isSyntheticChain(undefined, 'lab'));
  assert.ok(isSyntheticChain({ profile: { classificationSource: 'Eksplorator sandbox (dane syntetyczne)' } }));
  assert.ok(isSyntheticChain({ transfers: [{ explorerUrl: 'http://localhost:4100/explorer/address/x' }] }));
  assert.ok(!isSyntheticChain({ profile: { network: 'bitcoin', classificationSource: 'etykiety publiczne' }, transfers: [{ explorerUrl: 'https://mempool.space/tx/abc' }] }, 'bitcoin'));
  assert.ok(!isSyntheticChain(undefined, 'bitcoin'));
});
