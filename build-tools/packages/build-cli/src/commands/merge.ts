/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { getResolvedFluidRoot, GitRepo } from "@fluidframework/build-tools";
import { Octokit } from "@octokit/core";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../base";

const owner = "microsoft";
const repo = "FluidFramework";

async function prExists(token: string, title: string): Promise<boolean> {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo });

    for (const data of response.data) {
        if (data.title === title) {
            return true;
        }
    }

    return false;
}

async function prInfo(token: string, commitSha: string) {
    const octokit = new Octokit({ auth: token });
    await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        owner,
        repo,
        commitSha,
    });
}

async function createPR(token: string, sourceBranch: string, targetBranch: string, author: string) {
    const description = `
        ## Main-next integrate PR
        The aim of this pull request is to sync main and next branch. The expectation from the assignee is as follows:
        > - Acknowledge the pull request by adding a comment -- "Actively working on it".
        > - Resolve any merge conflicts between this branch and next (and push the resolution to this branch). Merge next into this branch if needed. **Do NOT rebase or squash this branch: its history must be preserved**.
        > - Ensure CI is passing for this PR, fixing any issues. Please don't look into resolving **Real service e2e test** and **Stress test** failures as they are **non-required** CI failures.
        For more information about how to resolve merge conflicts and CI failures, visit [this wiki page](https://github.com/microsoft/FluidFramework/wiki/Main-next-Automation).`;
    const octokit = new Octokit({ auth: token });
    const newPr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title: "Automate: Main Next Integrate",
        body: description,
        head: sourceBranch,
        base: targetBranch,
    });
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        owner,
        repo,
        // eslint-disable-next-line camelcase
        issue_number: newPr.data.number,
        assignees: [author],
    });
    await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner,
        repo,
        // eslint-disable-next-line camelcase
        pull_number: newPr.data.number,
        reviewer: [],
    });
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo,
        // eslint-disable-next-line camelcase
        issue_number: newPr.data.number,
        labels: ["main-next-integrate", "do-not-squash-merge"],
    });
}

export default class Merge extends BaseCommand<typeof Merge.flags> {
    static description = "Used to merge two branches.";

    static flags = {
        githubToken: Flags.string({
            description: "GitHub secret token",
            required: true,
            env: "GITHUB_TOKEN",
        }),
        owner: Flags.string({
            description: "Repository owner",
            default: "microsoft",
            hidden: true,
        }),
        repoName: Flags.string({
            description: "Repository name",
            default: "FluidFramework",
            hidden: true,
        }),
        sourceBranch: Flags.string({
            description: "Source branch name",
            char: "s",
            default: "main",
        }),
        targetBranch: Flags.string({
            description: "Target branch name",
            char: "t",
            default: "next",
        }),
        batchSize: Flags.integer({
            description: "Number of commits to include in the pull request",
            char: "b",
            default: 1,
            required: false,
        }),
        branchName: Flags.string({
            description: "Any specific branch name. Default would be source-target-SHA",
            required: false,
        }),
        reviewers: Flags.string({
            description: "Username of reviewers",
            char: "r",
            required: false,
            multiple: true,
        }),
        ...BaseCommand.flags,
    };

    static examples = [
        {
            description: "Example to use the merge command.",
            command: "<%= config.bin %> <%= command.id %> -s main -t next -r xyz -r abc -b 5",
        },
        {
            description: "Example to use the merge command.",
            command:
                "<%= config.bin %> <%= command.id %> --source=main --target=next --reviewers=xyz --reviewers=abc --batchSize=5",
        },
    ];

    public async run(): Promise<void> {
        const flags = this.processedFlags;

        const resolvedRoot = await getResolvedFluidRoot();
        const gitRepo = new GitRepo(resolvedRoot);

        // check if PR exists
        if (await prExists(flags.githubToken, "Automation: Main Next Integrate")) {
            this.exit(-1);
        }

        // last merged commit between source and target branch
        const lastMergedCommit = await gitRepo.mergeBase(flags.sourceBranch, flags.targetBranch);
        this.log(`Last merged commit in ${flags.targetBranch}------`, lastMergedCommit);
        // list of unmerged commits between source and target branch
        const unmergedCommits = await gitRepo.revList(lastMergedCommit, flags.sourceBranch);
        this.log(`List of unmerged commit in ${flags.sourceBranch} and ${flags.targetBranch}------`, unmergedCommits);

        if (
            unmergedCommits === undefined ||
            unmergedCommits === "" ||
            unmergedCommits.length === 0
        ) {
            this.log(
                `${flags.sourceBranch} and ${flags.targetBranch} are in sync. No commits to merge`,
            );
            this.exit(-1);
        }

        this.log(`there is a and ${flags.targetBranch} PR opened`);
    }
}
