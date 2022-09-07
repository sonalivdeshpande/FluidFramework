/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Contains a programatic API for generating {@link https://en.wikipedia.org/wiki/Markdown | Markdown} documentation
 * from an API report generated by {@link https://api-extractor.com/ | API-Extractor}.
 *
 * @remarks Akin to {@link https://github.com/microsoft/rushstack/tree/main/apps/api-documenter | API-Documenter} and
 * is heavily based upon it and uses it under the hood, but is designed to be more extensible and can be used
 * programatically.
 *
 * @packageDocumentation
 */

export {
    DocAlert,
    DocAlertType,
    DocEmphasisSpan,
    DocHeading,
    DocList,
    DocNoteBox,
    DocTable,
    DocTableCell,
    DocTableRow,
    IDocAlertParameters,
    IDocHeadingParameters,
    IDocListParameters,
    ListKind,
} from "./doc-nodes";
export * from "./rendering";
export * from "./utilities";

export * from "./Heading";
export * from "./Link";
export * from "./LoadModel";
export * from "./MarkdownDocument";
export * from "./MarkdownDocumenter";
export * from "./MarkdownDocumenterConfiguration";
export * from "./MarkdownEmitter";
export * from "./Policies";

// Conveinence re-exports of API model types
export { ApiItem, ApiItemKind, ApiModel, ApiPackage } from "@microsoft/api-extractor-model";
