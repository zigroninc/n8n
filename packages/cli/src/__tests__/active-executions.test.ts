import { mock } from 'jest-mock-extended';
import type {
	IDeferredPromise,
	IExecuteResponsePromiseData,
	IRun,
	IWorkflowExecutionDataProcess,
} from 'n8n-workflow';
import { ExecutionCancelledError } from 'n8n-workflow';
import PCancelable from 'p-cancelable';
import { v4 as uuid } from 'uuid';

import { ActiveExecutions } from '@/active-executions';
import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import type { ExecutionRepository } from '@/databases/repositories/execution.repository';
import { mockInstance } from '@test/mocking';

const FAKE_EXECUTION_ID = '15';
const FAKE_SECOND_EXECUTION_ID = '20';

const updateExistingExecution = jest.fn();
const createNewExecution = jest.fn(async () => FAKE_EXECUTION_ID);

const executionRepository = mock<ExecutionRepository>({
	updateExistingExecution,
	createNewExecution,
});

const concurrencyControl = mockInstance(ConcurrencyControlService, {
	// @ts-expect-error Private property
	isEnabled: false,
});

describe('ActiveExecutions', () => {
	let activeExecutions: ActiveExecutions;
	let responsePromise: IDeferredPromise<IExecuteResponsePromiseData>;
	let workflowExecution: PCancelable<IRun>;
	let postExecutePromise: Promise<IRun | undefined>;

	const fullRunData: IRun = {
		data: {
			resultData: {
				runData: {},
			},
		},
		mode: 'manual',
		startedAt: new Date(),
		status: 'new',
	};

	const executionData: IWorkflowExecutionDataProcess = {
		executionMode: 'manual',
		workflowData: {
			id: '123',
			name: 'Test workflow 1',
			active: false,
			createdAt: new Date(),
			updatedAt: new Date(),
			nodes: [],
			connections: {},
		},
		userId: uuid(),
	};

	beforeEach(() => {
		activeExecutions = new ActiveExecutions(mock(), executionRepository, concurrencyControl);

		workflowExecution = new PCancelable<IRun>((resolve) => resolve());
		workflowExecution.cancel = jest.fn();
		responsePromise = mock<IDeferredPromise<IExecuteResponsePromiseData>>();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	test('Should initialize activeExecutions with empty list', () => {
		expect(activeExecutions.getActiveExecutions()).toHaveLength(0);
	});

	test('Should add execution to active execution list', async () => {
		const executionId = await activeExecutions.add(executionData);

		expect(executionId).toBe(FAKE_EXECUTION_ID);
		expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
		expect(createNewExecution).toHaveBeenCalledTimes(1);
		expect(updateExistingExecution).toHaveBeenCalledTimes(0);
	});

	test('Should update execution if add is called with execution ID', async () => {
		const executionId = await activeExecutions.add(executionData, FAKE_SECOND_EXECUTION_ID);

		expect(executionId).toBe(FAKE_SECOND_EXECUTION_ID);
		expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
		expect(createNewExecution).toHaveBeenCalledTimes(0);
		expect(updateExistingExecution).toHaveBeenCalledTimes(1);
	});

	describe('attachWorkflowExecution', () => {
		test('Should fail attaching execution to invalid executionId', async () => {
			expect(() => {
				activeExecutions.attachWorkflowExecution(FAKE_EXECUTION_ID, workflowExecution);
			}).toThrow();
		});

		test('Should successfully attach execution to valid executionId', async () => {
			await activeExecutions.add(executionData, FAKE_EXECUTION_ID);

			expect(() =>
				activeExecutions.attachWorkflowExecution(FAKE_EXECUTION_ID, workflowExecution),
			).not.toThrow();
		});
	});

	test('Should attach and resolve response promise to existing execution', async () => {
		await activeExecutions.add(executionData, FAKE_EXECUTION_ID);
		activeExecutions.attachResponsePromise(FAKE_EXECUTION_ID, responsePromise);
		const fakeResponse = { data: { resultData: { runData: {} } } };
		activeExecutions.resolveResponsePromise(FAKE_EXECUTION_ID, fakeResponse);

		expect(responsePromise.resolve).toHaveBeenCalledWith(fakeResponse);
	});

	test('Should copy over startedAt and responsePromise when resuming a waiting execution', async () => {
		const executionId = await activeExecutions.add(executionData);
		activeExecutions.setStatus(executionId, 'waiting');
		activeExecutions.attachResponsePromise(executionId, responsePromise);

		const waitingExecution = activeExecutions.getExecutionOrFail(executionId);
		expect(waitingExecution.responsePromise).toBeDefined();

		// Resume the execution
		await activeExecutions.add(executionData, executionId);

		const resumedExecution = activeExecutions.getExecutionOrFail(executionId);
		expect(resumedExecution.startedAt).toBe(waitingExecution.startedAt);
		expect(resumedExecution.responsePromise).toBe(responsePromise);
	});

	describe('finalizeExecution', () => {
		test('Should not remove a waiting execution', async () => {
			const executionId = await activeExecutions.add(executionData);
			activeExecutions.setStatus(executionId, 'waiting');
			activeExecutions.finalizeExecution(executionId);

			// Wait until the next tick to ensure that the post-execution promise has settled
			await new Promise(setImmediate);

			// Execution should still be in activeExecutions
			expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
			expect(activeExecutions.getStatus(executionId)).toBe('waiting');
		});

		test('Should remove an existing execution', async () => {
			const executionId = await activeExecutions.add(executionData);

			activeExecutions.finalizeExecution(executionId);

			await new Promise(setImmediate);
			expect(activeExecutions.getActiveExecutions()).toHaveLength(0);
		});

		test('Should not try to resolve a post-execute promise for an inactive execution', async () => {
			const getExecutionSpy = jest.spyOn(activeExecutions, 'getExecutionOrFail');

			activeExecutions.finalizeExecution('inactive-execution-id', fullRunData);

			expect(getExecutionSpy).not.toHaveBeenCalled();
		});

		test('Should resolve post execute promise on removal', async () => {
			const executionId = await activeExecutions.add(executionData);
			const postExecutePromise = activeExecutions.getPostExecutePromise(executionId);

			await new Promise(setImmediate);
			activeExecutions.finalizeExecution(executionId, fullRunData);

			await expect(postExecutePromise).resolves.toEqual(fullRunData);
		});
	});

	describe('getPostExecutePromise', () => {
		test('Should throw error when trying to create a promise with invalid execution', async () => {
			await expect(activeExecutions.getPostExecutePromise(FAKE_EXECUTION_ID)).rejects.toThrow();
		});
	});

	describe('stopExecution', () => {
		let executionId: string;

		beforeEach(async () => {
			executionId = await activeExecutions.add(executionData);
			postExecutePromise = activeExecutions.getPostExecutePromise(executionId);

			activeExecutions.attachWorkflowExecution(executionId, workflowExecution);
			activeExecutions.attachResponsePromise(executionId, responsePromise);
		});

		test('Should cancel ongoing executions', async () => {
			activeExecutions.stopExecution(executionId);

			expect(responsePromise.reject).toHaveBeenCalledWith(expect.any(ExecutionCancelledError));
			expect(workflowExecution.cancel).toHaveBeenCalledTimes(1);
			await expect(postExecutePromise).rejects.toThrow(ExecutionCancelledError);
		});

		test('Should cancel waiting executions', async () => {
			activeExecutions.setStatus(executionId, 'waiting');
			activeExecutions.stopExecution(executionId);

			expect(responsePromise.reject).toHaveBeenCalledWith(expect.any(ExecutionCancelledError));
			expect(workflowExecution.cancel).not.toHaveBeenCalled();
		});
	});
});
