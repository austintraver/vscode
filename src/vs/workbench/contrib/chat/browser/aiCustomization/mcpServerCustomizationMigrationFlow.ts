/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICustomizationHarnessService } from '../../common/customizationHarnessService.js';
import { getMcpServerCustomizationMigrationCandidateKey, ICustomizationMigrationService, IMcpServerCustomizationMigrationCandidate, IMcpServerCustomizationMigrationResult } from '../../common/promptSyntax/service/customizationMigrationService.js';
import { ICustomizationMigrationCategorySummary } from './aiCustomizationWelcomePage.js';
import { CustomizationMigrationCategoryId, IMcpServerCustomizationMigrationCategory } from './customizationMigrationCategories.js';
import { ICustomizationMigrationModel, IMcpServerCustomizationMigrationCategoryState } from './customizationMigrationModel.js';
import { ICustomizationMigrationPageDelegate, SelectableCustomizationMigrationPage } from './customizationMigrationPage.js';
import { ICustomizationMigrationRunCoordinator } from './fileCustomizationMigrationFlow.js';
import type { ICustomizationMigrationFlow } from './customizationMigrationWidget.js';

export class McpServerCustomizationMigrationFlow extends Disposable implements ICustomizationMigrationFlow {
	readonly summary = observableValue<ICustomizationMigrationCategorySummary | undefined>(this, undefined);

	private readonly page: SelectableCustomizationMigrationPage<IMcpServerCustomizationMigrationCandidate>;
	private state: IMcpServerCustomizationMigrationCategoryState;

	constructor(
		readonly category: IMcpServerCustomizationMigrationCategory,
		private readonly runCoordinator: ICustomizationMigrationRunCoordinator,
		private readonly model: ICustomizationMigrationModel,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICustomizationMigrationService private readonly migrationService: ICustomizationMigrationService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
		this.state = {
			id: category.id,
			migrationType: category.migrationType,
			loading: false,
			candidates: [],
		};
		const pageDelegate: ICustomizationMigrationPageDelegate<IMcpServerCustomizationMigrationCandidate> = {
			getCandidateKey: getMcpServerCustomizationMigrationCandidateKey,
			getCandidatePresentation: candidate => this.category.getCandidatePresentation(
				candidate,
				uri => this.labelService.getUriLabel(uri, { relative: true }),
			),
			getHarnessLabel: () => this.getActiveHarnessLabel(),
			getDestinationLabel: () => undefined,
			migrate: candidates => this.migrateSelectedServers(candidates),
			retry: () => this.model.refresh([this.id]),
		};
		this.page = this._register(instantiationService.createInstance(
			SelectableCustomizationMigrationPage<IMcpServerCustomizationMigrationCandidate>,
			this.category,
			this.runCoordinator.inProgress,
			pageDelegate,
		));
		this._register(autorun(reader => {
			const state = this.model.state.read(reader).categories.get(this.id);
			if (!state || state.migrationType !== this.category.migrationType) {
				return;
			}
			this.state = state;
			this.updateSummary();
			this.page.update({
				loading: state.loading,
				loadError: state.loadError,
				candidates: this.getCandidates(),
			});
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

	layout(): void {
		this.page.layout();
	}

	private getCandidates(): readonly IMcpServerCustomizationMigrationCandidate[] {
		return this.isEnabled() && !this.state.loading && !this.state.loadError ? this.state.candidates : [];
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

	private async migrateSelectedServers(candidates: readonly IMcpServerCustomizationMigrationCandidate[]): Promise<void> {
		if (candidates.length === 0 || !this.isEnabled()) {
			return;
		}
		const runLock = this.runCoordinator.tryAcquire();
		if (!runLock) {
			return;
		}
		try {
			const context = this.model.captureContext();
			const confirmation = this.category.getConfirmation(candidates, this.getActiveHarnessLabel());
			const confirmResult = await this.dialogService.confirm({
				type: 'question',
				message: confirmation.message,
				detail: confirmation.detail,
				primaryButton: confirmation.primaryButton,
			});
			if (!confirmResult.confirmed || !this.model.isContextCurrent(context)) {
				return;
			}

			const writeLock = this.runCoordinator.beginWrite();
			let result: IMcpServerCustomizationMigrationResult;
			try {
				result = await this.migrationService.migrateMcpServers(context.sessionResource, candidates);
			} finally {
				await timeout(0);
				writeLock.dispose();
			}
			await this.model.refresh([this.id]);

			if (result.failures.length > 0) {
				this.notificationService.error(this.category.getFailureMessage(result.failures));
			}
			if (result.migratedCount > 0) {
				this.notificationService.info(this.category.getMigratedMessage(result.migratedCount));
			} else if (result.failures.length === 0) {
				this.notificationService.warn(this.category.nothingMigratedMessage);
			}
		} finally {
			runLock.dispose();
		}
	}

	private getActiveHarnessLabel(): string {
		return this.harnessService.getActiveDescriptor().label || localize('localHarnessLabel', "Local");
	}
}
