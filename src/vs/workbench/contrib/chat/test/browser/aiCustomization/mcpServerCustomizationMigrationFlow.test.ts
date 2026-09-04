/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { IManagedHover } from '../../../../../../base/browser/ui/hover/hover.js';
import { timeout } from '../../../../../../base/common/async.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { McpServerType } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { CustomizationMigrationCategoryId, getCustomizationMigrationCategory } from '../../../browser/aiCustomization/customizationMigrationCategories.js';
import { ICustomizationMigrationModel, ICustomizationMigrationModelState } from '../../../browser/aiCustomization/customizationMigrationModel.js';
import { CustomizationMigrationRunCoordinator } from '../../../browser/aiCustomization/fileCustomizationMigrationFlow.js';
import { McpServerCustomizationMigrationFlow } from '../../../browser/aiCustomization/mcpServerCustomizationMigrationFlow.js';
import { ICustomizationHarnessService } from '../../../common/customizationHarnessService.js';
import { CustomizationMigration, CustomizationMigrationType, FileCustomizationMigration, FileCustomizationMigrationType, ICustomizationMigrationService, IMcpServerCustomizationMigrationCandidate, IMcpServerCustomizationMigrationResult, McpServerCustomizationMigration, McpServerCustomizationMigrationFailureReason } from '../../../common/promptSyntax/service/customizationMigrationService.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';

class TestMigrationService implements ICustomizationMigrationService {
	declare readonly _serviceBrand: undefined;
	readonly requested: IMcpServerCustomizationMigrationCandidate[][] = [];
	result: IMcpServerCustomizationMigrationResult = { migratedCount: 0, failures: [] };

	computeMigration(_sessionResource: URI, type: FileCustomizationMigrationType): Promise<FileCustomizationMigration>;
	computeMigration(_sessionResource: URI, type: CustomizationMigrationType.McpServers): Promise<McpServerCustomizationMigration>;
	computeMigration(_sessionResource: URI, type: CustomizationMigrationType): Promise<CustomizationMigration> {
		return Promise.resolve(type === CustomizationMigrationType.McpServers
			? { type, servers: [], candidates: [], discoveryComplete: true, coverage: { restrictedByMcpAccess: false, restrictedByCustomizationPolicy: false } }
			: { type, files: [], candidates: [] });
	}

	migrateMcpServers(_sessionResource: URI, candidates: readonly IMcpServerCustomizationMigrationCandidate[]): Promise<IMcpServerCustomizationMigrationResult> {
		this.requested.push([...candidates]);
		return Promise.resolve(this.result);
	}

	computeMigrations(): Promise<CustomizationMigration[]> {
		return Promise.resolve([]);
	}

	computeMigrationHint(): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

suite('McpServerCustomizationMigrationFlow', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createCandidate(name: string, root = '/workspace'): IMcpServerCustomizationMigrationCandidate {
		return {
			type: CustomizationMigrationType.McpServers,
			id: `server-${name}`,
			name,
			sourceUri: URI.file(`${root}/.vscode/mcp.json`),
			targetUri: URI.file(`${root}/.mcp.json`),
			projectedConfiguration: { type: McpServerType.LOCAL, command: 'node' },
		};
	}

	function createFlow() {
		const category = getCustomizationMigrationCategory(CustomizationMigrationCategoryId.McpServers);
		const candidates = [createCandidate('Alpha'), createCandidate('Beta', '/other')];
		const modelState = observableValue<ICustomizationMigrationModelState>('modelState', {
			categories: new Map([[category.id, {
				id: category.id,
				migrationType: category.migrationType,
				loading: false,
				candidates,
			}]]),
		});
		let refreshCount = 0;
		const model: ICustomizationMigrationModel = {
			state: modelState,
			isCategoryEnabled: () => true,
			captureContext: () => ({
				generation: 0,
				harnessId: 'agent-host-test',
				sessionResource: activeSessionResource.get(),
				rootsSignature: '',
			}),
			isContextCurrent: context => context.generation === 0
				&& context.sessionResource.toString() === activeSessionResource.get().toString(),
			refresh: async () => { refreshCount++; },
		};
		const activeSessionResource = observableValue('activeSessionResource', URI.parse('agent-host-test:/session'));
		const harnessService = {
			activeSessionResource,
			getActiveDescriptor: () => ({ label: 'Copilot' }),
		} as unknown as ICustomizationHarnessService;
		const confirmations: string[] = [];
		const dialogService = {
			confirm: async ({ message }: { message: string }) => {
				confirmations.push(message);
				return { confirmed: true };
			},
		} as IDialogService;
		const notifications: string[] = [];
		const notificationService = {
			error: (message: string) => notifications.push(message),
			warn: (message: string) => notifications.push(message),
			info: (message: string) => notifications.push(message),
		} as unknown as INotificationService;
		const migrationService = new TestMigrationService();
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ICustomizationMigrationService, migrationService);
		instantiationService.stub(ICustomizationHarnessService, harnessService);
		instantiationService.stub(IDialogService, dialogService);
		instantiationService.stub(INotificationService, notificationService);
		instantiationService.stub(ILabelService, { getUriLabel: (uri: URI) => uri.path } as ILabelService);
		instantiationService.stub(IOpenerService, { open: async () => true } as unknown as IOpenerService);
		instantiationService.stub(IHoverService, {
			setupManagedHover: (): IManagedHover => ({ dispose() { }, show() { }, hide() { }, update() { } }),
		} as unknown as IHoverService);
		instantiationService.stub(IContextMenuService, { showContextMenu: () => undefined } as unknown as IContextMenuService);
		const coordinator = store.add(new CustomizationMigrationRunCoordinator());
		const flow = store.add(instantiationService.createInstance(McpServerCustomizationMigrationFlow, category, coordinator, model));
		const container = document.createElement('div');
		document.body.appendChild(container);
		flow.activate(container);
		flow.setVisible(true);
		const listContainer = container.querySelector<HTMLElement>('.prompt-migration-list')!;
		Object.defineProperty(listContainer, 'clientHeight', { configurable: true, value: 224 });
		flow.layout();
		return {
			flow,
			container,
			candidates,
			modelState,
			migrationService,
			coordinator,
			confirmations,
			notifications,
			getRefreshCount: () => refreshCount,
		};
	}

	test('renders source-to-target candidates without file actions', () => {
		const context = createFlow();
		try {
			assert.deepStrictEqual(
				[...context.container.querySelectorAll('.item-text:not([style*="display: none"]) .prompt-migration-item-path')].map(element => element.textContent),
				[
					'/workspace/.vscode/mcp.json to /workspace/.mcp.json',
					'/other/.vscode/mcp.json to /other/.mcp.json',
				],
			);
			assert.strictEqual(context.container.querySelector('.prompt-migration-open-button'), null);
			assert.strictEqual(context.container.querySelector('.prompt-migration-more-action'), null);
			assert.ok(context.container.textContent?.includes('Unsupported and unselected servers stay'));
		} finally {
			context.flow.dispose();
			context.container.remove();
		}
	});

	test('preserves stable selection when candidates are refreshed and reordered', () => {
		const context = createFlow();
		try {
			const checkboxes = context.container.querySelectorAll<HTMLElement>('.prompt-migration-checkbox .monaco-custom-toggle');
			checkboxes[0].click();
			context.modelState.set({
				categories: new Map([[CustomizationMigrationCategoryId.McpServers, {
					id: CustomizationMigrationCategoryId.McpServers,
					migrationType: CustomizationMigrationType.McpServers,
					loading: true,
					candidates: context.candidates,
				}]]),
			}, undefined);
			context.modelState.set({
				categories: new Map([[CustomizationMigrationCategoryId.McpServers, {
					id: CustomizationMigrationCategoryId.McpServers,
					migrationType: CustomizationMigrationType.McpServers,
					loading: false,
					candidates: [context.candidates[1], context.candidates[0]],
				}]]),
			}, undefined);

			const reordered = context.container.querySelectorAll<HTMLElement>('.prompt-migration-checkbox .monaco-custom-toggle');
			assert.deepStrictEqual([...reordered].map(element => element.getAttribute('aria-checked')), ['true', 'false']);
		} finally {
			context.flow.dispose();
			context.container.remove();
		}
	});

	test('shares the cross-flow lock, confirms, reports structured failures, and refreshes the model', async () => {
		const context = createFlow();
		try {
			const otherLock = context.coordinator.tryAcquire();
			assert.ok(otherLock);
			const migrateButton = context.container.querySelector<HTMLButtonElement>('.prompt-migration-button')!;
			assert.strictEqual(migrateButton.classList.contains('disabled'), true);
			otherLock.dispose();
			assert.strictEqual(migrateButton.classList.contains('disabled'), false);

			context.migrationService.result = {
				migratedCount: 1,
				failures: [{
					id: context.candidates[1].id,
					name: context.candidates[1].name,
					sourceUri: context.candidates[1].sourceUri,
					targetUri: context.candidates[1].targetUri,
					reason: McpServerCustomizationMigrationFailureReason.TargetConflict,
				}],
			};
			migrateButton.click();
			await timeout(10);

			assert.deepStrictEqual({
				confirmations: context.confirmations,
				requested: context.migrationService.requested.map(request => request.map(candidate => candidate.name)),
				notifications: context.notifications,
				refreshCount: context.getRefreshCount(),
			}, {
				confirmations: ['Migrate 2 MCP servers to .mcp.json?'],
				requested: [['Alpha', 'Beta']],
				notifications: [
					'Could not migrate \'Beta\' because .mcp.json already contains a different server with that name.',
					'Migrated 1 MCP server.',
				],
				refreshCount: 1,
			});
		} finally {
			context.flow.dispose();
			context.container.remove();
		}
	});
});
