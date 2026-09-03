/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { autorun, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { dirname as dirnamePath } from '../../../../../base/common/path.js';
import { basename, dirname, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAICustomizationWorkspaceService } from '../../common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService, ICustomizationSourceFolder } from '../../common/customizationHarnessService.js';
import { CustomizationMigrationType, getCustomizationMigrationTargetType, MigratableConfiguration } from '../../common/promptSyntax/service/customizationMigrationService.js';
import { PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { ICustomizationMigrationCategorySummary } from './aiCustomizationWelcomePage.js';
import { CustomizationMigrationTargetFolders, IMigratedCustomization, IMigratedCustomizationsResult, migrateCustomizations } from './customizationMigration.js';
import { CustomizationMigrationCategoryId, IFileCustomizationMigrationCategory } from './customizationMigrationCategories.js';
import { ICustomizationMigrationModel, IFileCustomizationMigrationCategoryState } from './customizationMigrationModel.js';
import { ICustomizationMigrationPageDelegate, SelectableCustomizationMigrationPage } from './customizationMigrationPage.js';
import type { ICustomizationMigrationFlow } from './customizationMigrationWidget.js';

interface IMigrationTargetQuickPickItem extends IQuickPickItem {
	readonly folder: ICustomizationSourceFolder;
}

export interface IFileCustomizationMigrationFlowDelegate {
	openFileCustomization(customization: MigratableConfiguration): Promise<void>;
	revealMigratedFiles(customizations: readonly IMigratedCustomization[]): Promise<void>;
}

export interface ICustomizationMigrationRunCoordinator {
	readonly inProgress: IObservable<boolean>;
	readonly writesInProgress: IObservable<boolean>;
	tryAcquire(): IDisposable | undefined;
	beginWrite(): IDisposable;
}

export class CustomizationMigrationRunCoordinator extends Disposable implements ICustomizationMigrationRunCoordinator {

	private readonly _inProgress = observableValue(this, false);
	readonly inProgress = this._inProgress;
	private readonly _writesInProgress = observableValue(this, false);
	readonly writesInProgress = this._writesInProgress;

	tryAcquire(): IDisposable | undefined {
		if (this._inProgress.get()) {
			return undefined;
		}

		this._inProgress.set(true, undefined);
		return toDisposable(() => this._inProgress.set(false, undefined));
	}

	beginWrite(): IDisposable {
		this._writesInProgress.set(true, undefined);
		return toDisposable(() => this._writesInProgress.set(false, undefined));
	}
}

export class FileCustomizationMigrationFlow extends Disposable implements ICustomizationMigrationFlow {

	readonly summary = observableValue<ICustomizationMigrationCategorySummary | undefined>(this, undefined);

	private readonly page: SelectableCustomizationMigrationPage<MigratableConfiguration>;
	private candidates: readonly MigratableConfiguration[] = [];
	private targetFoldersByType = new Map<PromptsType, readonly ICustomizationSourceFolder[]>();
	private state: IFileCustomizationMigrationCategoryState;

	constructor(
		readonly category: IFileCustomizationMigrationCategory,
		private readonly delegate: IFileCustomizationMigrationFlowDelegate,
		private readonly runCoordinator: ICustomizationMigrationRunCoordinator,
		private readonly model: ICustomizationMigrationModel,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IAICustomizationWorkspaceService private readonly workspaceService: IAICustomizationWorkspaceService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
		this.state = {
			id: category.id,
			migrationType: category.migrationType,
			loading: false,
			candidates: [],
			targetFoldersByType: new Map(),
		};
		const pageDelegate: ICustomizationMigrationPageDelegate<MigratableConfiguration> = {
			getCandidateKey: customization => `${customization.uri.toString()}:${customization.storage}`,
			getCandidatePresentation: customization => this.category.getCandidatePresentation(
				customization,
				uri => this.labelService.getUriLabel(uri, { relative: true }),
			),
			getCandidateActions: customization => [{
				id: 'customizationMigration.delete',
				label: localize('delete', "Delete"),
				icon: Codicon.trash,
				run: () => this.deleteCustomizationFile(customization),
			}],
			getHarnessLabel: () => this.getActiveHarnessLabel(),
			getDestinationLabel: customizations => this.getDestinationLabel(customizations.flatMap(customization => {
				const targetType = getCustomizationMigrationTargetType(customization);
				return this.targetFoldersByType.get(targetType)?.filter(folder => folder.source === customization.storage) ?? [];
			})),
			openCandidate: customization => this.delegate.openFileCustomization(customization),
			migrate: customizations => this.migrateSelectedCustomizations(customizations),
			retry: () => this.model.refresh([this.id]),
		};
		this.page = this._register(instantiationService.createInstance(
			SelectableCustomizationMigrationPage<MigratableConfiguration>,
			this.category,
			this.runCoordinator.inProgress,
			pageDelegate,
		));
		this._register(autorun(reader => {
			const state = this.model.state.read(reader).categories.get(this.id);
			if (!state || state.migrationType === CustomizationMigrationType.McpServers) {
				return;
			}
			this.state = state;
			this.candidates = state.candidates;
			this.targetFoldersByType = new Map(state.targetFoldersByType);
			this.updateSummary();
			this.updatePage();
		}));
	}

	get id(): CustomizationMigrationCategoryId {
		return this.category.id;
	}

	get backLabel(): string {
		return this.category.backLabel;
	}

	activate(container: HTMLElement): void {
		this.page.activate(container);
	}

	deactivate(): void {
		this.page.deactivate();
	}

	isEnabled(): boolean {
		return this.model.isCategoryEnabled(this.id);
	}

	refresh(): Promise<void> {
		return this.model.refresh([this.id]);
	}

	focus(): void {
		this.page.focus();
	}

	setVisible(visible: boolean): void {
		this.page.setVisible(visible);
	}

	layout(): void {
		this.page.layout();
	}

	async resolveTargetFolders(
		customizations: readonly MigratableConfiguration[],
		availableSourceFolders: ReadonlyMap<PromptsType, readonly ICustomizationSourceFolder[]>,
		sessionResource: URI,
		isContextCurrent: () => boolean = () => this.isSessionActive(sessionResource),
	): Promise<CustomizationMigrationTargetFolders | undefined> {
		const requiredStorageByTargetType = new Map<PromptsType, Set<PromptsStorage>>();
		for (const customization of customizations) {
			const targetType = getCustomizationMigrationTargetType(customization);
			const storages = requiredStorageByTargetType.get(targetType) ?? new Set<PromptsStorage>();
			storages.add(customization.storage);
			requiredStorageByTargetType.set(targetType, storages);
		}

		const targetFolders = new Map<PromptsType, ReadonlyMap<PromptsStorage, ICustomizationSourceFolder>>();
		const selectedDestinationGroupIds = new Map<PromptsStorage, string>();
		for (const [targetType, requiredStorages] of requiredStorageByTargetType) {
			const availableFolders = availableSourceFolders.get(targetType) ?? [];
			if (!isContextCurrent()) {
				return undefined;
			}
			const foldersByStorage = new Map<PromptsStorage, ICustomizationSourceFolder>();
			for (const storage of requiredStorages) {
				const matchingFolders = availableFolders.filter(folder => folder.source === storage);
				if (matchingFolders.length === 0) {
					this.notificationService.error(this.getMissingTargetFolderMessage(targetType, storage));
					return undefined;
				}

				const selectedDestinationGroupId = selectedDestinationGroupIds.get(storage);
				const foldersAtSelectedDestination = selectedDestinationGroupId
					? matchingFolders.filter(folder => folder.destinationGroupId === selectedDestinationGroupId)
					: [];
				let targetFolder: ICustomizationSourceFolder | undefined;
				if (foldersAtSelectedDestination.length === 1) {
					targetFolder = foldersAtSelectedDestination[0];
				} else if (matchingFolders.length === 1) {
					targetFolder = matchingFolders[0];
				} else {
					targetFolder = await this.pickTargetFolder(matchingFolders, targetType, requiredStorageByTargetType.size > 1);
					if (targetFolder?.destinationGroupId) {
						selectedDestinationGroupIds.set(storage, targetFolder.destinationGroupId);
					}
				}
				if (!targetFolder || !isContextCurrent()) {
					return undefined;
				}
				foldersByStorage.set(storage, targetFolder);
			}
			targetFolders.set(targetType, foldersByStorage);
		}
		return targetFolders;
	}

	private getCandidates(): readonly MigratableConfiguration[] {
		return this.isEnabled() && !this.state.loading && !this.state.loadError ? this.candidates : [];
	}

	private updateSummary(): void {
		const candidates = this.getCandidates();
		this.summary.set(candidates.length === 0 ? undefined : {
			id: this.category.id,
			label: this.category.cardLabel,
			description: this.category.getCardDescription(candidates, this.getActiveHarnessLabel()),
			actionLabel: this.category.cardActionLabel,
			actionAriaLabel: this.category.cardActionAriaLabel,
			count: candidates.length,
		}, undefined);
	}

	private updatePage(): void {
		const candidates = this.getCandidates();
		this.page.update({
			loading: this.state.loading,
			loadError: this.state.loadError,
			candidates,
		});
	}

	private getActiveHarnessLabel(): string {
		const label = this.harnessService.getActiveDescriptor().label;
		return label || (this.workspaceService.isSessionsWindow ? '' : localize('localHarnessLabel', "Local"));
	}

	private async migrateSelectedCustomizations(customizations: readonly MigratableConfiguration[]): Promise<void> {
		if (customizations.length === 0 || !this.isEnabled()) {
			return;
		}

		const runLock = this.runCoordinator.tryAcquire();
		if (!runLock) {
			return;
		}
		try {
			const context = this.model.captureContext();
			const targetFolders = await this.resolveTargetFolders(
				customizations,
				this.targetFoldersByType,
				context.sessionResource,
				() => this.model.isContextCurrent(context),
			);
			if (!targetFolders || !this.model.isContextCurrent(context)) {
				return;
			}

			const confirmation = this.category.getConfirmation(
				customizations,
				this.getActiveHarnessLabel(),
				this.getDestinationLabel([...targetFolders.values()].flatMap(foldersByStorage => [...foldersByStorage.values()])),
			);
			const confirmResult = await this.dialogService.confirm({
				type: 'question',
				message: confirmation.message,
				detail: confirmation.detail,
				checkbox: {
					label: confirmation.deleteOriginalsLabel,
					checked: true,
				},
				primaryButton: confirmation.primaryButton,
			});
			if (!confirmResult.confirmed || !this.model.isContextCurrent(context)) {
				return;
			}

			const deleteOriginalFiles = confirmResult.checkboxChecked !== false;
			const migrationResult = await this.runMigration(customizations, targetFolders, deleteOriginalFiles);
			const { migratedCount, failedCustomizationFileNames, unsupportedHeaderKeys, migratedCustomizations } = migrationResult;

			if (failedCustomizationFileNames.length > 0) {
				const displayedFileNames = failedCustomizationFileNames.slice(0, 3);
				const hiddenFileCount = failedCustomizationFileNames.length - displayedFileNames.length;
				this.notificationService.error(this.category.getFailedMessage(displayedFileNames, hiddenFileCount));
			}

			if (migratedCount === 0) {
				if (failedCustomizationFileNames.length === 0) {
					this.notificationService.warn(this.category.noFilesMigratedMessage);
				}
				return;
			}

			if (deleteOriginalFiles) {
				await this.model.refresh([this.id]);
			}

			const unsupportedKeysLabel = unsupportedHeaderKeys.join(', ');
			this.notificationService.info(unsupportedKeysLabel.length > 0 && this.category.getMigratedWithReviewMessage
				? this.category.getMigratedWithReviewMessage(migratedCount, unsupportedKeysLabel)
				: this.category.getMigratedMessage(migratedCount));

			if (deleteOriginalFiles) {
				void this.delegate.revealMigratedFiles(migratedCustomizations);
			}
		} finally {
			runLock.dispose();
		}
	}

	private async runMigration(customizations: readonly MigratableConfiguration[], targetFolders: CustomizationMigrationTargetFolders, deleteOriginalFiles: boolean): Promise<IMigratedCustomizationsResult> {
		const writeLock = this.runCoordinator.beginWrite();
		try {
			return await migrateCustomizations(customizations, targetFolders, this.fileService, onUnexpectedError, { deleteOriginalFiles });
		} finally {
			await timeout(0);
			writeLock.dispose();
		}
	}

	private async deleteCustomizationFile(customization: MigratableConfiguration): Promise<void> {
		const runLock = this.runCoordinator.tryAcquire();
		if (!runLock) {
			return;
		}
		try {
			const fileName = customization.name ?? basename(customization.uri);
			const confirmation = await this.dialogService.confirm({
				message: localize('confirmDeleteCustomizationFile', "Are you sure you want to delete '{0}'?", fileName),
				detail: localize('confirmDeleteDetail', "This action cannot be undone."),
				primaryButton: localize('delete', "Delete"),
				type: 'warning',
			});
			if (!confirmation.confirmed) {
				return;
			}

			const writeLock = this.runCoordinator.beginWrite();
			try {
				const useTrash = this.fileService.hasCapability(customization.uri, FileSystemProviderCapabilities.Trash);
				await this.fileService.del(customization.uri, { useTrash });
				if (customization.storage === PromptsStorage.local) {
					const projectRoot = this.workspaceService.getActiveProjectRoot();
					if (projectRoot) {
						await this.workspaceService.deleteFiles(projectRoot, [customization.uri]);
					}
				}
			} finally {
				await timeout(0);
				writeLock.dispose();
			}

			await this.model.refresh([this.id]);
		} finally {
			runLock.dispose();
		}
	}

	private isSessionActive(sessionResource: URI): boolean {
		return isEqual(sessionResource, this.harnessService.activeSessionResource.get());
	}

	private getMissingTargetFolderMessage(targetType: PromptsType, storage: PromptsStorage): string {
		if (storage === PromptsStorage.local) {
			switch (targetType) {
				case PromptsType.skill:
					return localize('migrationNoWorkspaceSkillFolder', "No workspace skills folder is configured for the active harness.");
				case PromptsType.agent:
					return localize('migrationNoWorkspaceAgentFolder', "No workspace agents folder is configured for the active harness.");
				default:
					return localize('migrationNoWorkspaceInstructionsFolder', "No workspace instructions folder is configured for the active harness.");
			}
		}
		switch (targetType) {
			case PromptsType.skill:
				return localize('migrationNoGlobalSkillFolder', "No global skills folder is configured for the active harness.");
			case PromptsType.agent:
				return localize('migrationNoGlobalAgentFolder', "No global agents folder is configured for the active harness.");
			default:
				return localize('migrationNoGlobalInstructionsFolder', "No global instructions folder is configured for the active harness.");
		}
	}

	private async pickTargetFolder(sourceFolders: readonly ICustomizationSourceFolder[], targetType: PromptsType, selectsMultipleTypes: boolean): Promise<ICustomizationSourceFolder | undefined> {
		const picks: IMigrationTargetQuickPickItem[] = sourceFolders.map(folder => ({
			label: folder.label,
			description: this.labelService.getUriLabel(folder.uri, { relative: true }),
			folder,
		}));
		const selected = await this.quickInputService.pick(picks, {
			canPickMany: false,
			placeHolder: this.getTargetFolderPlaceholder(targetType, selectsMultipleTypes),
			matchOnDescription: true,
		});
		return selected?.folder;
	}

	private getTargetFolderPlaceholder(targetType: PromptsType, selectsMultipleTypes: boolean): string {
		if (selectsMultipleTypes) {
			return localize('migrationPickCustomizationFolder', "Select a destination for the migrated customizations");
		}
		switch (targetType) {
			case PromptsType.skill:
				return localize('migrationPickSkillFolder', "Select a destination folder for migrated skills");
			case PromptsType.agent:
				return localize('migrationPickAgentFolder', "Select a destination folder for migrated agents");
			default:
				return localize('migrationPickInstructionsFolder', "Select a destination folder for migrated instructions");
		}
	}

	private getDestinationLabel(folders: readonly ICustomizationSourceFolder[]): string | undefined {
		const seen = new ResourceSet();
		const uniqueFolders = folders.filter(folder => {
			if (seen.has(folder.uri)) {
				return false;
			}
			seen.add(folder.uri);
			return true;
		});
		if (uniqueFolders.length === 0) {
			return undefined;
		}

		const commonLabel = uniqueFolders[0].label;
		if (commonLabel && uniqueFolders.every(folder => folder.label === commonLabel)) {
			return commonLabel;
		}

		const labelParent = dirnamePath(uniqueFolders[0].label);
		if (labelParent !== '.' && uniqueFolders.every(folder => dirnamePath(folder.label) === labelParent)) {
			return labelParent;
		}

		let destination = uniqueFolders[0].uri;
		if (uniqueFolders.length > 1) {
			const commonParent = dirname(destination);
			if (!uniqueFolders.every(folder => isEqual(dirname(folder.uri), commonParent))) {
				return undefined;
			}
			destination = commonParent;
		}
		return this.labelService.getUriLabel(destination);
	}
}
