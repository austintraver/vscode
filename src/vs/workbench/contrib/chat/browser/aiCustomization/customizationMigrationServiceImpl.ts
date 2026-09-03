/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { equals } from '../../../../../base/common/objects.js';
import { getComparisonKey, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { isAgentHostSessionResource } from '../../common/chatSessionsService.js';
import { ICustomizationHarnessService, ICustomizationSourceFolder } from '../../common/customizationHarnessService.js';
import { getChatSessionType } from '../../common/model/chatUri.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { CustomizationMigration, CustomizationMigrationType, FileCustomizationMigration, FileCustomizationMigrationType, getCustomizationMigrationTargetType, getMcpServerCustomizationMigrationCandidateKey, ICustomizationMigrationService, IMcpServerCustomizationMigrationCandidate, IMcpServerCustomizationMigrationFailure, IMcpServerCustomizationMigrationResult, isPromptFileMigrationCandidate, isUserDataMigrationCandidate, McpServerCustomizationMigration, McpServerCustomizationMigrationFailureReason, MigratableConfiguration } from '../../common/promptSyntax/service/customizationMigrationService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { IAgentHostActiveClientService } from '../agentSessions/agentHost/agentHostActiveClientService.js';
import { IAgentHostCustomizationService } from '../agentSessions/agentHost/agentHostCustomizationService.js';
import { AgentHostMcpServerApplicability } from '../agentSessions/agentHost/agentHostMcpServerSupport.js';
import { McpServerCustomizationMigrator } from './mcpServerCustomizationMigration.js';

export class CustomizationMigrationService extends Disposable implements ICustomizationMigrationService {
	declare readonly _serviceBrand: undefined;
	private readonly mcpServerMigration: McpServerCustomizationMigrator;
	private activeContextKey = '';
	private activeContextGeneration = 0;

	constructor(
		@IPromptsService private readonly promptsService: IPromptsService,
		@ICustomizationHarnessService private readonly customizationHarnessService: ICustomizationHarnessService,
		@IAgentHostActiveClientService private readonly activeClientService: IAgentHostActiveClientService,
		@IAgentHostCustomizationService private readonly agentHostCustomizationService: IAgentHostCustomizationService,
		@IFileService fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.mcpServerMigration = new McpServerCustomizationMigrator(fileService);
		this._register(autorun(reader => {
			const sessionResource = this.customizationHarnessService.activeSessionResource.read(reader);
			this.updateActiveContext(sessionResource);
		}));
		this._register(this.agentHostCustomizationService.onDidChangeCustomizations(() => {
			this.updateActiveContext(this.customizationHarnessService.activeSessionResource.get());
		}));
	}

	computeMigration(sessionResource: URI, type: FileCustomizationMigrationType): Promise<FileCustomizationMigration>;
	computeMigration(sessionResource: URI, type: CustomizationMigrationType.McpServers): Promise<McpServerCustomizationMigration>;
	async computeMigration(sessionResource: URI, type: CustomizationMigrationType): Promise<CustomizationMigration> {
		if (!isAgentHostSessionResource(sessionResource)) {
			return type === CustomizationMigrationType.McpServers
				? this.emptyMcpServerMigration()
				: { type, files: [], candidates: [] };
		}

		switch (type) {
			case CustomizationMigrationType.UserData: {
				const customizations = (await Promise.all([
					this.promptsService.listPromptFiles(PromptsType.agent, CancellationToken.None),
					this.promptsService.listPromptFiles(PromptsType.instructions, CancellationToken.None),
				])).flat();
				return this.createFileMigration(sessionResource, type, customizations.filter(isUserDataMigrationCandidate));
			}
			case CustomizationMigrationType.PromptFiles: {
				const customizations = await this.promptsService.listPromptFiles(PromptsType.prompt, CancellationToken.None);
				return this.createFileMigration(sessionResource, type, customizations.filter(isPromptFileMigrationCandidate));
			}
			case CustomizationMigrationType.McpServers:
				return this.computeMcpServerMigration(sessionResource);
		}
	}

	async computeMigrations(sessionResource: URI): Promise<CustomizationMigration[]> {
		return Promise.all([
			this.computeMigration(sessionResource, CustomizationMigrationType.UserData),
			this.computeMigration(sessionResource, CustomizationMigrationType.PromptFiles),
			this.computeMigration(sessionResource, CustomizationMigrationType.McpServers),
		]);
	}

	async migrateMcpServers(sessionResource: URI, requestedCandidates: readonly IMcpServerCustomizationMigrationCandidate[]): Promise<IMcpServerCustomizationMigrationResult> {
		if (requestedCandidates.length === 0) {
			return { migratedCount: 0, failures: [] };
		}

		const roots = this.getWorkingDirectoryUris(sessionResource);
		const contextGeneration = this.activeContextGeneration;
		if (!this.isExecutionContextCurrent(sessionResource, roots, contextGeneration)) {
			return { migratedCount: 0, failures: requestedCandidates.map(candidate => this.noLongerEligible(candidate)) };
		}

		const currentMigration = await this.computeMcpServerMigration(sessionResource, roots);
		if (!this.isExecutionContextCurrent(sessionResource, roots, contextGeneration)) {
			return { migratedCount: 0, failures: requestedCandidates.map(candidate => this.noLongerEligible(candidate)) };
		}

		const currentCandidates = new Map(currentMigration.candidates.map(candidate => [getMcpServerCustomizationMigrationCandidateKey(candidate), candidate]));
		const eligibleCandidates: IMcpServerCustomizationMigrationCandidate[] = [];
		const failures: IMcpServerCustomizationMigrationFailure[] = [];
		for (const requested of requestedCandidates) {
			const current = currentCandidates.get(getMcpServerCustomizationMigrationCandidateKey(requested));
			if (!current || !equals(current.projectedConfiguration, requested.projectedConfiguration)) {
				failures.push(this.noLongerEligible(requested));
			} else {
				eligibleCandidates.push(current);
			}
		}

		this.logService.info(`[MCP Customization Migration] Starting: selected=${requestedCandidates.length}, eligible=${eligibleCandidates.length}, stale=${failures.length}`);
		const result = await this.mcpServerMigration.migrate(eligibleCandidates, {
			isContextCurrent: () => this.isExecutionContextCurrent(sessionResource, roots, contextGeneration),
		});
		const combined = { migratedCount: result.migratedCount, failures: [...failures, ...result.failures] };
		for (const failure of combined.failures) {
			if (failure.error) {
				this.logService.error(`[MCP Customization Migration] Failed: reason=${failure.reason}, server=${failure.name}`, failure.error);
			} else {
				this.logService.warn(`[MCP Customization Migration] Failed: reason=${failure.reason}, server=${failure.name}`);
			}
		}
		this.logService.info(`[MCP Customization Migration] Finished: migrated=${combined.migratedCount}, failed=${combined.failures.length}`);
		return combined;
	}

	async computeMigrationHint(sessionResource: URI): Promise<string | undefined> {
		const harness = this.customizationHarnessService.findHarnessById(getChatSessionType(sessionResource));
		if (!harness) {
			return undefined;
		}

		const [userDataMigration, promptFilesMigration, mcpServerMigration] = await Promise.all([
			this.computeMigration(sessionResource, CustomizationMigrationType.UserData),
			this.computeMigration(sessionResource, CustomizationMigrationType.PromptFiles),
			this.computeMigration(sessionResource, CustomizationMigrationType.McpServers),
		]);
		const fileCount = userDataMigration.files.length + promptFilesMigration.files.length;
		const migratableMcpServerCount = mcpServerMigration.candidates.length;
		const unsupportedMcpServerCount = mcpServerMigration.servers.filter(server => !server.supported).length;
		const fileHint = fileCount === 0
			? undefined
			: fileCount === 1
				? localize('customizationMigrationHintSingle', "Found 1 customization file that is present but not used by {0} and could be migrated.", harness.label)
				: localize('customizationMigrationHintMultiple', "Found {0} customization files that are present but not used by {1} and could be migrated.", fileCount, harness.label);
		const migratableMcpHint = migratableMcpServerCount === 0
			? undefined
			: migratableMcpServerCount === 1
				? localize('customizationMigrationHintMigratableMcpSingle', "Found 1 workspace MCP server that can be migrated for {0}.", harness.label)
				: localize('customizationMigrationHintMigratableMcpMultiple', "Found {0} workspace MCP servers that can be migrated for {1}.", migratableMcpServerCount, harness.label);
		const unsupportedMcpHint = unsupportedMcpServerCount === 0
			? undefined
			: unsupportedMcpServerCount === 1
				? localize('customizationMigrationHintMcpSingle', "Found 1 MCP server that is not fully supported by {0}.", harness.label)
				: localize('customizationMigrationHintMcpMultiple', "Found {0} MCP servers that are not fully supported by {1}.", unsupportedMcpServerCount, harness.label);
		if (fileHint && migratableMcpHint && unsupportedMcpHint) {
			return localize('customizationMigrationHintCombinedAll', "{0} {1} {2}", fileHint, migratableMcpHint, unsupportedMcpHint);
		}
		const firstHint = fileHint ?? migratableMcpHint;
		const secondHint = firstHint === fileHint ? migratableMcpHint ?? unsupportedMcpHint : unsupportedMcpHint;
		if (firstHint && secondHint) {
			return localize('customizationMigrationHintCombined', "{0} {1}", firstHint, secondHint);
		}
		return firstHint ?? unsupportedMcpHint;
	}

	private async createFileMigration(sessionResource: URI, type: FileCustomizationMigrationType, candidates: readonly MigratableConfiguration[]): Promise<FileCustomizationMigration> {
		const provider = this.customizationHarnessService.findHarnessById(getChatSessionType(sessionResource))?.itemProvider;
		if (!provider?.provideSourceFolders) {
			return { type, files: [], candidates: [] };
		}

		const targetTypes = new Set(candidates.map(getCustomizationMigrationTargetType));
		const sourceFolders = new Map<PromptsType, readonly ICustomizationSourceFolder[]>();
		for (const targetType of targetTypes) {
			const folders = await provider.provideSourceFolders(sessionResource, targetType, CancellationToken.None);
			sourceFolders.set(targetType, folders ?? []);
		}
		const filteredCandidates = candidates.filter(customization => {
			const targetType = getCustomizationMigrationTargetType(customization);
			return sourceFolders.get(targetType)?.some(folder => folder.source === customization.storage) === true;
		});
		return { type, files: filteredCandidates.map(customization => customization.uri), candidates: filteredCandidates };
	}

	private async computeMcpServerMigration(sessionResource: URI, expectedRoots?: readonly URI[]): Promise<McpServerCustomizationMigration> {
		const roots = this.getWorkingDirectoryUris(sessionResource);
		if (expectedRoots && !this.areRootsEqual(expectedRoots, roots)) {
			return this.emptyMcpServerMigration();
		}
		const scope = this.activeClientService.acquireMcpServerSupportScope(getChatSessionType(sessionResource), roots);
		if (!scope) {
			return this.emptyMcpServerMigration();
		}

		try {
			await scope.whenResolved();
			if (!this.areRootsEqual(roots, this.getWorkingDirectoryUris(sessionResource))) {
				return this.emptyMcpServerMigration();
			}
			const snapshot = scope.support.get();
			const plan = await this.mcpServerMigration.createPlan(snapshot, roots);
			if (!this.areRootsEqual(roots, this.getWorkingDirectoryUris(sessionResource))) {
				return this.emptyMcpServerMigration();
			}
			return {
				type: CustomizationMigrationType.McpServers,
				servers: snapshot.servers
					.filter(server => server.applicability !== AgentHostMcpServerApplicability.OutsideCurrentScope)
					.map(server => ({
						id: server.id,
						name: server.name,
						supported: server.compatibility.kind === 'supported',
					})),
				candidates: plan.candidates,
				discoveryComplete: snapshot.discoveryComplete,
				coverage: snapshot.coverage,
			};
		} finally {
			scope.dispose();
		}
	}

	private emptyMcpServerMigration(): McpServerCustomizationMigration {
		return {
			type: CustomizationMigrationType.McpServers,
			servers: [],
			candidates: [],
			discoveryComplete: true,
			coverage: {
				restrictedByMcpAccess: false,
				restrictedByCustomizationPolicy: false,
			},
		};
	}

	private getWorkingDirectoryUris(sessionResource: URI): readonly URI[] {
		return this.agentHostCustomizationService.getWorkingDirectories(sessionResource).map(value => {
			const parsed = URI.parse(value);
			return parsed.scheme ? parsed : URI.file(value);
		});
	}

	private isExecutionContextCurrent(sessionResource: URI, roots: readonly URI[], generation: number): boolean {
		return isEqual(sessionResource, this.customizationHarnessService.activeSessionResource.get())
			&& generation === this.activeContextGeneration
			&& this.areRootsEqual(roots, this.getWorkingDirectoryUris(sessionResource));
	}

	private areRootsEqual(first: readonly URI[], second: readonly URI[]): boolean {
		return first.length === second.length && first.every((root, index) => isEqual(root, second[index]));
	}

	private noLongerEligible(candidate: IMcpServerCustomizationMigrationCandidate): IMcpServerCustomizationMigrationFailure {
		return {
			id: candidate.id,
			name: candidate.name,
			sourceUri: candidate.sourceUri,
			targetUri: candidate.targetUri,
			reason: McpServerCustomizationMigrationFailureReason.NoLongerEligible,
		};
	}

	private updateActiveContext(sessionResource: URI): void {
		const roots = this.getWorkingDirectoryUris(sessionResource);
		const key = JSON.stringify([getComparisonKey(sessionResource), ...roots.map(root => getComparisonKey(root))]);
		if (key !== this.activeContextKey) {
			this.activeContextKey = key;
			this.activeContextGeneration++;
		}
	}
}
