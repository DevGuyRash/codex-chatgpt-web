import { expect, test } from "bun:test";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test("tool dispatch waits for parking and tool delivery waits for generation reacquisition", async () => {
  const progress = new ChatGptExternalTurnProgress();
  let parked!: () => void, resumed!: () => void;
  progress.setGenerationGate({
    park: () => new Promise<void>(resolve => { parked = resolve; }),
    resume: () => new Promise<void>(resolve => { resumed = resolve; }),
  });
  const revision = progress.recordToolBatch(1);
  let dispatch = false, deliver = false;
  const observation = progress.waitForToolBatchObservation(revision).then(() => { dispatch = true; });
  const acknowledgement = progress.acknowledgeToolBatch(revision);
  await Promise.resolve();
  expect(dispatch).toBe(false);
  parked(); await acknowledgement; await observation;
  expect(dispatch).toBe(true);
  const preparation = progress.prepareToolResults().then(() => { deliver = true; });
  await Promise.resolve();
  expect(deliver).toBe(false);
  resumed(); await preparation;
  expect(deliver).toBe(true);
  progress.recordToolResult();
  await expect(progress.prepareToolResults()).rejects.toThrow("observed active batch");
});

test("retirement while waiting for a generation permit cannot release a tool result", async () => {
  const progress = new ChatGptExternalTurnProgress();
  let resumed!: () => void;
  progress.setGenerationGate({ park: async () => {}, resume: () => new Promise<void>(resolve => { resumed = resolve; }) });
  const revision = progress.recordToolBatch(1);
  await progress.acknowledgeToolBatch(revision);
  const preparation = progress.prepareToolResults();
  const failure = new Error("browser owner ended");
  progress.retire(failure);
  resumed();
  await expect(preparation).rejects.toBe(failure);
});
