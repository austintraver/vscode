/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Throttler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { getComparisonKey, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { isAgentHostTarget } from '../../common/chatSessionsService.js';
import { ICustomizationHarnessService, ICustomizationSourceFolder, IHarnessDescriptor } from '../../common/customizationHarnessService.js';
import { CustomizationMigrationType, ICustomizationMigrationService, IMcpServerCustomizationMigrationCandidate, MigratableConfiguration } from '../../common/promptSyntax/service/customizationMigrationService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IMcpService, IMcpWorkbenchService } from '../../../mcp/common/mcpTypes.js';
import { IAgentHostCustomizationService } from '../agentSessions/agentHost/agentHostCustomizationService.js';
import { CUSTOMIZATION_MIGRATION_CATEGORIES, CustomizationMigrationCategoryId, ICustomizationMigrationCategory } from './customizationMigrationCategories.js';

interface IBaseCustomizationMigrationCategoryState {
	readonly id: CustomizationMigrationCategoryId;
	readonly loading: boolean;
	readonly loadError?: string;
}

export interface IFileCustomizationMigrationCategoryState extends IBaseCustomizationMigrationCategoryState {
	readonly migrationType: CustomizationMigrationType.PromptFiles | CustomizationMigrationType.UserData;
	readonly candidates: readonly MigratableConfiguration[];
	readonly targetFoldersByType: ReadonlyMap<PromptsType, readonly ICustomizationSourceFolder[]>;
}

export interface IMcpServerCustomizationMigrationCategoryState extends IBaseCustomizationMigrationCategoryState {
	readonly migrationType: CustomizationMigrationType.McpServers;
	readonly candidates: readonly IMcpServerCustomizationMigrationCandidate[];
}

export type CustomizationMigrationCategoryState = IFileCustomizationMigrationCategoryState | IMcpServerCustomizationMigrationCategoryState;

export interface ICustomizationMigrationModelState {
	readonly categories: ReadonlyMap<CustomizationMigrationCategoryId, CustomizationMigrationCategoryState>;
}

export interface ICustomizationMigrationModel {
	readonly state: IObservable<ICustomizationMigrationModelState>;
	isCategoryEnabled(categoryId: CustomizationMigrationCategoryId): boolean;
	refresh(categoryIds?: readonly CustomizationMigrationCategoryId[]): Promise<void>;
	captureContext(): ICustomizationMigrationExecutionContext;
	isContextCurrent(context: ICustomizationMigrationExecutionContext): boolean;
}

export interface ICustomizationMigrationExecutionContext {
	readonly generation: number;
	readonly harnessId: string;
	readonly sessionResource: URI;
	readonly rootsSignature: string;
}

interface ICustomizationMigrationRefreshContext extends ICustomizationMigrationExecutionContext {
	readonly refreshGeneration: number;
}

const allCategoryIds = CUSTOMIZATION_MIGRATION_CATEGORIES.map(category => category.id);

/**
 * Owns migration discovery, context invalidation, and category snapshots.
 */
export class CustomizationMigrationModel extends Disposable implements ICustomizationMigrationModel {
	private readonly _state = observableValue<ICustomizationMigrationModelState>(this, createEmptyState());
	readonly state: IObservable<ICustomizationMigrationModelState> = this._state;

	private readonly pendingCategories = new Set<CustomizationMigrationCategoryId>();
	private readonly refreshThrottler = this._register(new Throttler());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.runPendingRefresh(), 0));
	private contextGeneration = 0;
	private refreshGeneration = 0;
	private contextKey = '';
	private rootsSignature = '';
	private isDisposed = false;

	constructor(
		private readonly writesInProgress: IObservable<boolean>,
		@ICustomizationMigrationService private readonly migrationService: ICustomizationMigrationService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IPromptsService promptsService: IPromptsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMcpService mcpService: IMcpService,
		@IMcpWorkbenchService mcpWorkbenchService: IMcpWorkbenchService,
		@IAgentHostCustomizationService private readonly agentHostCustomizationService: IAgentHostCustomizationService,
	) {
		super();

		this._register(promptsService.onDidChangeSlashCommands(() => this.scheduleRefresh([CustomizationMigrationCategoryId.PromptFiles])));
		this._register(Event.any(
			promptsService.onDidChangeCustomAgents,
			promptsService.onDidChangeInstructions,
			promptsService.onDidChangeAgentInstructions,
		)(() => this.scheduleRefresh([CustomizationMigrationCategoryId.UserData])));

		this._register(this.configurationService.onDidChangeConfiguration(event => {
			for (const category of CUSTOMIZATION_MIGRATION_CATEGORIES) {
				if (category.enablementSetting && event.affectsConfiguration(category.enablementSetting)) {
					this.scheduleRefresh([category.id]);
				}
			}
		}));

		this._register(autorun(reader => {
			const sessionResource = this.harnessService.activeSessionResource.read(reader);
			const harnessId = this.harnessService.activeHarness.read(reader);
			const rootsSignature = this.getRootsSignature(sessionResource);
			const contextKey = `${harnessId}\n${getComparisonKey(sessionResource)}\n${rootsSignature}`;
			if (contextKey !== this.contextKey) {
				this.contextKey = contextKey;
				this.rootsSignature = rootsSignature;
				this.invalidateContext();
			}
			this.scheduleRefresh();
		}));
		const harnessProviderListener = this._register(new MutableDisposable());
		let activeHarnessDescriptor: IHarnessDescriptor | undefined;
		this._register(autorun(reader => {
			this.harnessService.availableHarnesses.read(reader);
			const harnessId = this.harnessService.activeHarness.read(reader);
			const descriptor = this.harnessService.findHarnessById(harnessId);
			if (descriptor !== activeHarnessDescriptor) {
				activeHarnessDescriptor = descriptor;
				harnessProviderListener.value = descriptor?.itemProvider?.onDidChange(() => this.scheduleRefresh());
				this.invalidateContext();
				this.scheduleRefresh();
			}
		}));

		this._register(this.agentHostCustomizationService.onDidChangeCustomizations(() => {
			const sessionResource = this.harnessService.activeSessionResource.get();
			const rootsSignature = this.getRootsSignature(sessionResource);
			if (rootsSignature !== this.rootsSignature) {
				this.rootsSignature = rootsSignature;
				this.contextKey = `${this.harnessService.activeHarness.get()}\n${getComparisonKey(sessionResource)}\n${rootsSignature}`;
				this.invalidateContext();
				this.scheduleRefresh();
			} else {
				this.scheduleRefresh();
			}
		}));

		this._register(autorun(reader => {
			for (const server of mcpService.servers.read(reader)) {
				server.enablement.read(reader);
				server.readDefinitions().read(reader);
			}
			this.scheduleRefresh([CustomizationMigrationCategoryId.McpServers]);
		}));
		this._register(Event.any(mcpWorkbenchService.onChange, mcpWorkbenchService.onReset)(() => {
			this.scheduleRefresh([CustomizationMigrationCategoryId.McpServers]);
		}));

		this._register(autorun(reader => {
			if (!this.writesInProgress.read(reader) && this.pendingCategories.size > 0) {
				this.refreshScheduler.schedule();
			}
		}));
	}

	override dispose(): void {
		this.isDisposed = true;
		this.contextGeneration++;
		this.refreshGeneration++;
		super.dispose();
	}

	isCategoryEnabled(categoryId: CustomizationMigrationCategoryId): boolean {
		const category = CUSTOMIZATION_MIGRATION_CATEGORIES.find(candidate => candidate.id === categoryId);
		return !!category && (!category.enablementSetting || this.configurationService.getValue<boolean>(category.enablementSetting) === true);
	}

	async refresh(categoryIds: readonly CustomizationMigrationCategoryId[] = allCategoryIds): Promise<void> {
		this.refreshScheduler.cancel();
		this.refreshGeneration++;
		this.addPendingCategories(categoryIds);
		await this.runPendingRefresh();
	}

	private scheduleRefresh(categoryIds: readonly CustomizationMigrationCategoryId[] = allCategoryIds): void {
		if (this.isDisposed) {
			return;
		}
		this.refreshGeneration++;
		this.addPendingCategories(categoryIds);
		if (!this.writesInProgress.get()) {
			this.refreshScheduler.schedule();
		}
	}

	private addPendingCategories(categoryIds: readonly CustomizationMigrationCategoryId[]): void {
		for (const categoryId of categoryIds) {
			this.pendingCategories.add(categoryId);
		}
	}

	private runPendingRefresh(): Promise<void> {
		if (this.pendingCategories.size === 0 || this.isDisposed || this.writesInProgress.get()) {
			return Promise.resolve();
		}
		return this.refreshThrottler.queue(async () => {
			while (this.pendingCategories.size > 0 && !this.isDisposed && !this.writesInProgress.get()) {
				const categoryIds = new Set(this.pendingCategories);
				this.pendingCategories.clear();
				await this.refreshCategories(categoryIds);
			}
		});
	}

	private async refreshCategories(categoryIds: ReadonlySet<CustomizationMigrationCategoryId>): Promise<void> {
		const context = this.captureRefreshContext();
		const categories = CUSTOMIZATION_MIGRATION_CATEGORIES.filter(category => categoryIds.has(category.id));
		const loadingCategories = new Map(this._state.get().categories);
		for (const category of categories) {
			loadingCategories.set(category.id, this.withLoading(loadingCategories.get(category.id) ?? createEmptyCategoryState(category)));
		}
		this._state.set({ categories: loadingCategories }, undefined);

		if (!isAgentHostTarget(context.harnessId)) {
			this.publishIfCurrent(context, categories.map(category => createEmptyCategoryState(category)));
			return;
		}

		const results = await Promise.all(categories.map(async category => {
			if (!this.isCategoryEnabled(category.id)) {
				return createEmptyCategoryState(category);
			}
			try {
				return await this.computeCategoryState(context, category);
			} catch (error) {
				const previous = this._state.get().categories.get(category.id) ?? createEmptyCategoryState(category);
				return {
					...previous,
					loading: false,
					loadError: getErrorMessage(error),
				};
			}
		}));
		this.publishIfCurrent(context, results);
	}

	private async computeCategoryState(
		context: ICustomizationMigrationRefreshContext,
		category: ICustomizationMigrationCategory,
	): Promise<CustomizationMigrationCategoryState> {
		switch (category.migrationType) {
			case CustomizationMigrationType.McpServers: {
				const migration = await this.migrationService.computeMigration(context.sessionResource, CustomizationMigrationType.McpServers);
				return {
					id: category.id,
					migrationType: category.migrationType,
					loading: false,
					candidates: migration.candidates,
				};
			}
			case CustomizationMigrationType.PromptFiles:
			case CustomizationMigrationType.UserData: {
				const migration = await this.migrationService.computeMigration(context.sessionResource, category.migrationType);
				const targetTypes = new Set(migration.candidates.map(candidate => candidate.type === PromptsType.prompt ? PromptsType.skill : candidate.type));
				const provider = this.harnessService.findHarnessById(context.harnessId)?.itemProvider;
				const targetFolderEntries = await Promise.all([...targetTypes].map(async targetType => {
					const folders = await provider?.provideSourceFolders?.(context.sessionResource, targetType, CancellationToken.None);
					return [targetType, folders ?? []] as const;
				}));
				return {
					id: category.id,
					migrationType: category.migrationType,
					loading: false,
					candidates: migration.candidates,
					targetFoldersByType: new Map(targetFolderEntries),
				};
			}
		}
	}

	private withLoading(state: CustomizationMigrationCategoryState): CustomizationMigrationCategoryState {
		return {
			...state,
			loading: true,
			loadError: undefined,
		};
	}

	private publishIfCurrent(context: ICustomizationMigrationRefreshContext, results: readonly CustomizationMigrationCategoryState[]): void {
		if (!this.isRefreshCurrent(context)) {
			if (!this.isDisposed) {
				this.addPendingCategories(results.map(result => result.id));
			}
			return;
		}
		const categories = new Map(this._state.get().categories);
		for (const result of results) {
			categories.set(result.id, result);
		}
		this._state.set({ categories }, undefined);
	}

	captureContext(): ICustomizationMigrationExecutionContext {
		const sessionResource = this.harnessService.activeSessionResource.get();
		return {
			generation: this.contextGeneration,
			harnessId: this.harnessService.activeHarness.get(),
			sessionResource,
			rootsSignature: this.getRootsSignature(sessionResource),
		};
	}

	private captureRefreshContext(): ICustomizationMigrationRefreshContext {
		return {
			...this.captureContext(),
			refreshGeneration: this.refreshGeneration,
		};
	}

	isContextCurrent(context: ICustomizationMigrationExecutionContext): boolean {
		return !this.isDisposed
			&& context.generation === this.contextGeneration
			&& context.harnessId === this.harnessService.activeHarness.get()
			&& isEqual(context.sessionResource, this.harnessService.activeSessionResource.get())
			&& context.rootsSignature === this.getRootsSignature(context.sessionResource);
	}

	private isRefreshCurrent(context: ICustomizationMigrationRefreshContext): boolean {
		return context.refreshGeneration === this.refreshGeneration && this.isContextCurrent(context);
	}

	private invalidateContext(): void {
		this.contextGeneration++;
		this.refreshGeneration++;
		this._state.set(createEmptyState(), undefined);
	}

	private getRootsSignature(sessionResource: URI): string {
		return this.agentHostCustomizationService.getWorkingDirectories(sessionResource).join('\n');
	}
}

function createEmptyState(): ICustomizationMigrationModelState {
	return {
		categories: new Map(CUSTOMIZATION_MIGRATION_CATEGORIES.map(category => [category.id, createEmptyCategoryState(category)])),
	};
}

function createEmptyCategoryState(category: ICustomizationMigrationCategory): CustomizationMigrationCategoryState {
	switch (category.migrationType) {
		case CustomizationMigrationType.McpServers:
			return {
				id: category.id,
				migrationType: category.migrationType,
				loading: false,
				candidates: [],
			};
		case CustomizationMigrationType.PromptFiles:
		case CustomizationMigrationType.UserData:
			return {
				id: category.id,
				migrationType: category.migrationType,
				loading: false,
				candidates: [],
				targetFoldersByType: new Map(),
			};
	}
}
