/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../../base/common/async.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { observableValue, waitForState } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { McpServerType } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { CustomizationMigrationCategoryId } from '../../../browser/aiCustomization/customizationMigrationCategories.js';
import { CustomizationMigrationModel } from '../../../browser/aiCustomization/customizationMigrationModel.js';
import { IAgentHostCustomizationService } from '../../../browser/agentSessions/agentHost/agentHostCustomizationService.js';
import { ICustomizationHarnessService, IHarnessDescriptor } from '../../../common/customizationHarnessService.js';
import { CustomizationMigration, CustomizationMigrationType, FileCustomizationMigration, FileCustomizationMigrationType, ICustomizationMigrationService, IMcpServerCustomizationMigrationResult, McpServerCustomizationMigration } from '../../../common/promptSyntax/service/customizationMigrationService.js';
import { PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { MockPromptsService } from '../../common/promptSyntax/service/mockPromptsService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { IMcpService, IMcpWorkbenchService } from '../../../../mcp/common/mcpTypes.js';

class TestMigrationService implements ICustomizationMigrationService {
	declare readonly _serviceBrand: undefined;
	readonly calls: { readonly session: string; readonly type: CustomizationMigrationType }[] = [];
	readonly versions = new Map<CustomizationMigrationType, number>();
	beforeCompute?: (type: CustomizationMigrationType) => Promise<void>;
	failType: CustomizationMigrationType | undefined;

	computeMigration(sessionResource: URI, type: FileCustomizationMigrationType): Promise<FileCustomizationMigration>;
	computeMigration(sessionResource: URI, type: CustomizationMigrationType.McpServers): Promise<McpServerCustomizationMigration>;
	async computeMigration(sessionResource: URI, type: CustomizationMigrationType): Promise<CustomizationMigration> {
		this.calls.push({ session: sessionResource.path, type });
		await this.beforeCompute?.(type);
		if (type === this.failType) {
			throw new Error(`Failed ${type}`);
		}
		const version = this.versions.get(type) ?? 0;
		if (type === CustomizationMigrationType.McpServers) {
			return {
				type,
				servers: [],
				candidates: [{
					type,
					id: `server-${version}`,
					name: `Server ${version}`,
					sourceUri: URI.file('/workspace/.vscode/mcp.json'),
					targetUri: URI.file('/workspace/.mcp.json'),
					projectedConfiguration: { type: McpServerType.LOCAL, command: 'node' },
				}],
				discoveryComplete: true,
				coverage: { restrictedByMcpAccess: false, restrictedByCustomizationPolicy: false },
			};
		}
		const candidates = [{
			uri: URI.file(`/${type}-${sessionResource.path.slice(1)}-${version}.md`),
			storage: PromptsStorage.user,
			type: type === CustomizationMigrationType.PromptFiles ? PromptsType.prompt : PromptsType.instructions,
		}];
		return { type, files: candidates.map(candidate => candidate.uri), candidates };
	}

	migrateMcpServers(): Promise<IMcpServerCustomizationMigrationResult> {
		return Promise.resolve({ migratedCount: 0, failures: [] });
	}

	async computeMigrations(sessionResource: URI): Promise<CustomizationMigration[]> {
		return Promise.all([
			this.computeMigration(sessionResource, CustomizationMigrationType.UserData),
			this.computeMigration(sessionResource, CustomizationMigrationType.PromptFiles),
			this.computeMigration(sessionResource, CustomizationMigrationType.McpServers),
		]);
	}

	computeMigrationHint(): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

suite('CustomizationMigrationModel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createModel() {
		const activeSessionResource = observableValue('activeSessionResource', URI.parse('agent-host-test:/session-a'));
		const activeHarness = observableValue('activeHarness', 'agent-host-test');
		const writesInProgress = observableValue('writesInProgress', false);
		const promptsService = store.add(new MockPromptsService());
		const promptFilesChanged = store.add(new Emitter<void>());
		const userDataChanged = store.add(new Emitter<void>());
		Object.defineProperties(promptsService, {
			onDidChangeSlashCommands: { value: promptFilesChanged.event },
			onDidChangeCustomAgents: { value: userDataChanged.event },
			onDidChangeInstructions: { value: Event.None },
			onDidChangeAgentInstructions: { value: Event.None },
		});
		const migrationService = new TestMigrationService();
		let targetPrefix = '/target';
		let harnessDescriptor: IHarnessDescriptor = {
			id: 'agent-host-test',
			label: 'Test',
			icon: Codicon.beaker,
			itemProvider: {
				onDidChange: Event.None,
				provideChatSessionCustomizations: async () => [],
				provideSourceFolders: async (_resource: URI, type: PromptsType) => [{
					uri: URI.file(`${targetPrefix}/${type}`),
					label: String(type),
					source: PromptsStorage.user,
				}],
			},
		};
		const availableHarnesses = observableValue<readonly IHarnessDescriptor[]>('availableHarnesses', [harnessDescriptor]);
		const harnessService = new class extends mock<ICustomizationHarnessService>() {
			override readonly activeSessionResource = activeSessionResource;
			override readonly activeHarness = activeHarness;
			override readonly availableHarnesses = availableHarnesses;
			override findHarnessById() {
				return harnessDescriptor;
			}
		}();
		const replaceHarnessDescriptor = () => {
			targetPrefix = '/replacement';
			harnessDescriptor = {
				id: 'agent-host-test',
				label: 'Test',
				icon: Codicon.beaker,
				itemProvider: {
					onDidChange: Event.None,
					provideChatSessionCustomizations: async () => [],
					provideSourceFolders: async (_resource: URI, type: PromptsType) => [{
						uri: URI.file(`${targetPrefix}/${type}`),
						label: String(type),
						source: PromptsStorage.user,
					}],
				},
			};
			availableHarnesses.set([harnessDescriptor], undefined);
		};
		const configurationService = {
			onDidChangeConfiguration: Event.None,
			getValue: () => true,
		} as Partial<IConfigurationService> as IConfigurationService;
		const mcpServers = observableValue<readonly never[]>('mcpServers', []);
		const mcpService = { servers: mcpServers } as Partial<IMcpService> as IMcpService;
		const mcpWorkbenchService = {
			onChange: Event.None,
			onReset: Event.None,
		} as Partial<IMcpWorkbenchService> as IMcpWorkbenchService;
		const customizationsChanged = store.add(new Emitter<void>());
		let roots: readonly string[] = ['file:///workspace'];
		const agentHostCustomizationService = {
			onDidChangeCustomizations: customizationsChanged.event,
			getWorkingDirectories: () => roots,
		} as Partial<IAgentHostCustomizationService> as IAgentHostCustomizationService;
		const model = store.add(new CustomizationMigrationModel(
			writesInProgress,
			migrationService,
			harnessService,
			promptsService,
			configurationService,
			mcpService,
			mcpWorkbenchService,
			agentHostCustomizationService,
		));
		return {
			model,
			migrationService,
			activeSessionResource,
			activeHarness,
			writesInProgress,
			promptFilesChanged,
			userDataChanged,
			mcpServers,
			customizationsChanged,
			setRoots: (value: readonly string[]) => roots = value,
			replaceHarnessDescriptor,
		};
	}

	test('invalidates targeted categories for session, harness, roots, prompts, and MCP inventory', async () => {
		const context = createModel();
		await waitForState(context.model.state, state => [...state.categories.values()].every(category => !category.loading && category.candidates.length > 0));
		context.migrationService.calls.length = 0;

		context.promptFilesChanged.fire();
		await waitForCalls(context.migrationService, 1);
		assert.deepStrictEqual(context.migrationService.calls.map(call => call.type), [CustomizationMigrationType.PromptFiles]);

		context.migrationService.calls.length = 0;
		context.userDataChanged.fire();
		await waitForCalls(context.migrationService, 1);
		assert.deepStrictEqual(context.migrationService.calls.map(call => call.type), [CustomizationMigrationType.UserData]);

		context.migrationService.calls.length = 0;
		context.mcpServers.set([], undefined);
		await waitForCalls(context.migrationService, 1);
		assert.deepStrictEqual(context.migrationService.calls.map(call => call.type), [CustomizationMigrationType.McpServers]);

		const executionContext = context.model.captureContext();
		context.migrationService.calls.length = 0;
		context.customizationsChanged.fire();
		await waitForCalls(context.migrationService, 3);
		assert.strictEqual(context.model.isContextCurrent(executionContext), true);

		context.migrationService.calls.length = 0;
		context.setRoots(['file:///workspace', 'file:///other']);
		context.customizationsChanged.fire();
		await waitForCalls(context.migrationService, 3);

		context.migrationService.calls.length = 0;
		context.activeSessionResource.set(URI.parse('agent-host-test:/session-b'), undefined);
		await waitForCalls(context.migrationService, 3);
		assert.ok(context.migrationService.calls.every(call => call.session === '/session-b'));

		const descriptorContext = context.model.captureContext();
		context.migrationService.calls.length = 0;
		context.replaceHarnessDescriptor();
		await waitForCalls(context.migrationService, 3);
		assert.strictEqual(context.model.isContextCurrent(descriptorContext), false);
		const promptState = context.model.state.get().categories.get(CustomizationMigrationCategoryId.PromptFiles);
		assert.strictEqual(promptState?.migrationType === CustomizationMigrationType.PromptFiles
			? promptState.targetFoldersByType.get(PromptsType.skill)?.[0].uri.path
			: undefined, '/replacement/skill');

		context.migrationService.calls.length = 0;
		context.activeHarness.set('local', undefined);
		await waitForState(context.model.state, state => [...state.categories.values()].every(category => category.candidates.length === 0));
		assert.deepStrictEqual(context.migrationService.calls, []);
	});

	test('serializes partial refreshes, preserves untouched categories, and isolates category errors', async () => {
		const context = createModel();
		await waitForState(context.model.state, state => [...state.categories.values()].every(category => !category.loading && category.candidates.length > 0));
		const initialMcpState = context.model.state.get().categories.get(CustomizationMigrationCategoryId.McpServers);
		assert.strictEqual(initialMcpState?.migrationType, CustomizationMigrationType.McpServers);
		const originalMcpId = initialMcpState.candidates[0].id;
		const promptStarted = new DeferredPromise<void>();
		const releasePrompt = new DeferredPromise<void>();
		context.migrationService.versions.set(CustomizationMigrationType.PromptFiles, 1);
		context.migrationService.failType = CustomizationMigrationType.UserData;
		context.migrationService.beforeCompute = async type => {
			if (type === CustomizationMigrationType.PromptFiles) {
				promptStarted.complete();
				await releasePrompt.p;
			}
		};

		const promptRefresh = context.model.refresh([CustomizationMigrationCategoryId.PromptFiles]);
		await promptStarted.p;
		const userRefresh = context.model.refresh([CustomizationMigrationCategoryId.UserData]);
		releasePrompt.complete();
		await Promise.all([promptRefresh, userRefresh]);

		const state = context.model.state.get();
		const promptState = state.categories.get(CustomizationMigrationCategoryId.PromptFiles);
		const mcpState = state.categories.get(CustomizationMigrationCategoryId.McpServers);
		assert.strictEqual(promptState?.migrationType, CustomizationMigrationType.PromptFiles);
		assert.strictEqual(mcpState?.migrationType, CustomizationMigrationType.McpServers);
		assert.deepStrictEqual({
			prompt: promptState.candidates[0].uri.path,
			userError: state.categories.get(CustomizationMigrationCategoryId.UserData)?.loadError,
			mcpId: mcpState.candidates[0].id,
		}, {
			prompt: '/promptFiles-session-a-1.md',
			userError: 'Failed userData',
			mcpId: originalMcpId,
		});
	});

	test('coalesces invalidations during writes and rejects disposed refresh results', async () => {
		const context = createModel();
		await waitForState(context.model.state, state => [...state.categories.values()].every(category => !category.loading && category.candidates.length > 0));
		context.migrationService.calls.length = 0;
		context.writesInProgress.set(true, undefined);
		context.promptFilesChanged.fire();
		context.promptFilesChanged.fire();
		await timeout(10);
		assert.deepStrictEqual([...context.migrationService.calls], []);

		context.writesInProgress.set(false, undefined);
		await waitForCalls(context.migrationService, 1);
		assert.deepStrictEqual(context.migrationService.calls.map(call => call.type), [CustomizationMigrationType.PromptFiles]);

		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		context.migrationService.beforeCompute = async type => {
			if (type === CustomizationMigrationType.PromptFiles) {
				started.complete();
				await release.p;
			}
		};
		const refresh = context.model.refresh([CustomizationMigrationCategoryId.PromptFiles]);
		await started.p;
		const stateBeforeDispose = context.model.state.get();
		context.model.dispose();
		release.complete();
		await refresh;
		assert.strictEqual(context.model.state.get(), stateBeforeDispose);
	});
});

async function waitForCalls(service: TestMigrationService, count: number): Promise<void> {
	for (let index = 0; index < 100 && service.calls.length < count; index++) {
		await timeout(1);
	}
	assert.ok(service.calls.length >= count, `Expected ${count} calls, got ${service.calls.length}`);
}
