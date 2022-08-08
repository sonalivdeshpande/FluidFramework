import { createBranch, mergeBase, revList } from "@fluidframework/build-tools";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../base";

const owner = "microsoft";
const repo = "FluidFramework";

async function listLabels(token: string) {
    // const octokit = new Octokit({ auth: token });
    // await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    //     owner: owner,
    //     repo: repo,
    //     issue_number: 'ISSUE_NUMBER'
    // })
}

async function addLabel(token: string, issueNumber: number, labels: string[]) {
    // const octokit = new Octokit({ auth: token });
    // await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    //     owner: owner,
    //     repo: repo,
    //     issue_number: issue_number,
    //     labels: labels,
    // });
    // labels: [
    //     'main-next-integrate',
    //     'do-not-squash-merge'
    // ]
}

async function prExists(token?: string, title?: string): Promise<boolean> {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo });

    for (const i of response.data) {
        if (response.data[i].title === title) {
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

async function createPR(
    token: string,
    sourceBranch: string,
    targetBranch: string,
    author: string,
    reviewers: string[],
    title?: string,
) {
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
        title,
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
        reviewers,
    });
}

export default class Merge extends BaseCommand<typeof BaseCommand.flags> {
    static description = "describe the command here";

    static examples = ["<%= config.bin %> <%= command.id %>"];

    static flags = {
        githubToken: Flags.string({
            description: "GitHub secret token",
            required: true,
        }),
        source: Flags.string({
            description: "Source branch name",
            default: "main",
            required: false,
        }),
        target: Flags.string({
            description: "Target branch name",
            default: "next",
            required: false,
        }),
        batchSize: Flags.integer({
            description: "Number of commits to include in the pull request",
            default: 1,
            required: false,
        }),
        branchName: Flags.string({
            description: "Any specific branch name. Default would be main-next-SHA",
            required: false,
        }),
        reviewers: Flags.string({
            description: "Username of reviewers",
            required: false,
        }),
        title: Flags.string({
            description: "PR title name",
            required: false,
        }),
        assignee: Flags.string({
            description: "PR assignee",
            required: false,
        }),
        ...BaseCommand.flags,
    };

    public async run(): Promise<void> {
        const { flags } = await this.parse(Merge);

        // check if PR exists
        if (await prExists()) {
            this.exit(-1);
        }

        const lastMergedCommit = await mergeBase(flags.source, flags.target);
        const unmergedCommits = await revList(lastMergedCommit, flags.source);
        this.log("unmerged commit------", unmergedCommits);

        if (
            unmergedCommits === undefined ||
            unmergedCommits === "" ||
            unmergedCommits.length === 0
        ) {
            this.log(`${flags.source} and ${flags.target} are in sync. Not commits to merge`);
            this.exit(-1);
        }

        // check if commits equal to specific bacth size exists
        const lastCommitID: string =
            unmergedCommits.length <= flags.batchSize
                ? unmergedCommits[unmergedCommits.length - 1]
                : unmergedCommits[flags.batchSize - 1];

        const syncbranchName: string = flags.branchName ?? `main-next-${lastCommitID}`;

        // iterate and get the last commit
        const commitInfo: any = await prInfo("", lastCommitID);
        this.log("commit info----", commitInfo);

        // create branch
        await createBranch(syncbranchName);

        // create pull request
        const pullRequest = await createPR("", syncbranchName, flags.target, commitInfo.actor, [
            "sonalivdeshpande",
        ]);
        this.log(`PR opened upto ${lastCommitID}`);

        if (pullRequest === undefined || pullRequest === "") {
            this.error("Unable to create pull request");
            // notify the process owner
        }

        this.log(`there is a ${syncbranchName} and ${flags.target} PR opened`);
    }
}
