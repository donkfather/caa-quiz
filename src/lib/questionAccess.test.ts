import { test } from "node:test";
import assert from "node:assert/strict";
import { availableQuestions, extraCount, isOfficial, restorable } from "./questionAccess.ts";

const bundled = new Set([1, 2, 3]);

test("an explicit flag wins over the bundled-id fallback, both ways", () => {
  assert.equal(isOfficial({ id: 1, official: false }, bundled), false);
  assert.equal(isOfficial({ id: 900, official: true }, bundled), true);
});

test("without the flag, a question shipped in the app is official and anything else is an extra", () => {
  assert.equal(isOfficial({ id: 2 }, bundled), true);
  assert.equal(isOfficial({ id: 600 }, bundled), false);
});

test("before the unlock only official questions are served; after it, all of them", () => {
  const all = [
    { id: 1, official: true },
    { id: 576, official: false },
    { id: 2 }, // old bundle, shipped id
    { id: 700 }, // old bundle, added later
  ];
  assert.deepEqual(availableQuestions(all, false, bundled).map((q) => q.id), [1, 2]);
  assert.equal(availableQuestions(all, true, bundled), all);
  assert.equal(extraCount(all, bundled), 2);
});

test("an old cached bundle with no flags still gates the extras (no leak while offline)", () => {
  const oldBundle = [{ id: 1 }, { id: 3 }, { id: 576 }, { id: 881 }];
  assert.deepEqual(availableQuestions(oldBundle, false, bundled).map((q) => q.id), [1, 3]);
});

test("a saved session only resumes with questions the user may be served right now", () => {
  const all = [{ id: 1, official: true }, { id: 2, official: true }, { id: 576, official: false }];
  const locked = availableQuestions(all, false, bundled);
  // Started while unlocked, resumed after the unlock went away: start over.
  assert.equal(restorable([1, 576], locked), null);
  assert.deepEqual(restorable([2, 1], locked)?.map((q) => q.id), [2, 1]);
  // A question retired by an update is missing too.
  assert.equal(restorable([1, 3], locked), null);
  assert.equal(restorable([], locked), null);
});
