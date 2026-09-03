/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { assertNever } from '../../../../../base/common/assert.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable } from '../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { CustomizationMigrationType, MigratableConfiguration } from '../../common/promptSyntax/service/customizationMigrationService.js';
import { CUSTOMIZATION_MIGRATION_CATEGORIES, CustomizationMigrationCategoryId, ICustomizationMigrationCategory } from './customizationMigrationCategories.js';
import { IMigratedCustomization } from './customizationMigration.js';
import { CustomizationMigrationRunCoordinator, FileCustomizationMigrationFlow, IFileCustomizationMigrationFlowDelegate } from './fileCustomizationMigrationFlow.js';
import { ICustomizationMigrationCategorySummary } from './aiCustomizationWelcomePage.js';
import { CustomizationMigrationModel } from './customizationMigrationModel.js';
import { McpServerCustomizationMigrationFlow } from './mcpServerCustomizationMigrationFlow.js';

const $ = DOM.$;

export interface ICustomizationMigrationFlow extends IDisposable {
	readonly id: CustomizationMigrationCategoryId;
	readonly backLabel: string;
	readonly summary: IObservable<ICustomizationMigrationCategorySummary | undefined>;

	activate(container: HTMLElement): void;
	deactivate(): void;
	refresh(): Promise<void>;
	focus(): void;
	setVisible(visible: boolean): void;
	layout(): void;
	isEnabled(): boolean;
}

export interface ICustomizationMigrationNavigationDelegate {
	openFileCustomization(customization: MigratableConfiguration): Promise<void>;
	revealMigratedFiles(customizations: readonly IMigratedCustomization[]): Promise<void>;
}

export class CustomizationMigrationWidget extends Disposable {

	readonly element: HTMLElement;
	readonly summaries: IObservable<readonly ICustomizationMigrationCategorySummary[]>;

	private readonly flows: readonly ICustomizationMigrationFlow[];
	private readonly model: CustomizationMigrationModel;
	private activeFlow: ICustomizationMigrationFlow | undefined;
	private visible = false;

	constructor(
		navigationDelegate: ICustomizationMigrationNavigationDelegate,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this.element = $('.prompt-migration-content-container.ai-customization-list-widget');
		const flowDelegate: IFileCustomizationMigrationFlowDelegate = navigationDelegate;
		const runCoordinator = this._register(new CustomizationMigrationRunCoordinator());
		this.model = this._register(instantiationService.createInstance(CustomizationMigrationModel, runCoordinator.writesInProgress));
		this.flows = CUSTOMIZATION_MIGRATION_CATEGORIES.map(category => this._register(
			this.createFlow(category, flowDelegate, runCoordinator, instantiationService)
		));
		this.summaries = derived(this, reader => this.flows
			.map(flow => flow.summary.read(reader))
			.filter((summary): summary is ICustomizationMigrationCategorySummary => summary !== undefined));
	}

	get activeBackLabel(): string | undefined {
		return this.activeFlow?.backLabel;
	}

	showCategory(categoryId: CustomizationMigrationCategoryId): boolean {
		const flow = this.flows.find(candidate => candidate.id === categoryId);
		if (!flow?.isEnabled()) {
			return false;
		}

		if (this.activeFlow !== flow) {
			this.activeFlow?.setVisible(false);
			this.activeFlow?.deactivate();
			this.activeFlow = flow;
			flow.activate(this.element);
		} else {
			flow.activate(this.element);
		}
		flow.setVisible(this.visible);
		return true;
	}

	async refresh(): Promise<void> {
		await this.model.refresh();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.element.style.display = visible ? '' : 'none';
		this.activeFlow?.setVisible(visible);
	}

	focus(): void {
		this.activeFlow?.focus();
	}

	layout(): void {
		this.activeFlow?.layout();
	}

	private createFlow(
		category: ICustomizationMigrationCategory,
		fileDelegate: IFileCustomizationMigrationFlowDelegate,
		runCoordinator: CustomizationMigrationRunCoordinator,
		instantiationService: IInstantiationService,
	): ICustomizationMigrationFlow {
		switch (category.migrationType) {
			case CustomizationMigrationType.PromptFiles:
			case CustomizationMigrationType.UserData:
				return instantiationService.createInstance(FileCustomizationMigrationFlow, category, fileDelegate, runCoordinator, this.model);
			case CustomizationMigrationType.McpServers:
				return instantiationService.createInstance(McpServerCustomizationMigrationFlow, category, runCoordinator, this.model);
			default:
				return assertNever(category);
		}
	}
}
