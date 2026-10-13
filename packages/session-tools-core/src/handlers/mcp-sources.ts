/**
 * MCP source resources & prompts handlers — source_list_resources /
 * source_read_resource / source_list_prompts / source_get_prompt.
 *
 * MCP servers publish more than tools: resources (documents such as guides,
 * schemas or files, addressed by URI) and prompts (reusable instructions with
 * arguments). The protocol calls, blob saving and large-result handling happen
 * behind ctx.mcpSources (the session's MCP pool), which also limits them to the
 * session's enabled, connected sources.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const MCP_SOURCES_UNAVAILABLE =
  'MCP resources and prompts are not available in this context.';

const TRUNCATED_NOTE = ' (the server has more; the list stops at the page limit)';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ============================================================
// source_list_resources
// ============================================================

export interface SourceListResourcesArgs {
  sourceSlug: string;
}

export async function handleSourceListResources(
  ctx: SessionToolContext,
  args: SourceListResourcesArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');

  try {
    const { resources, resourceTemplates, truncated } = await ctx.mcpSources.listResources(sourceSlug);
    if (resources.length === 0 && resourceTemplates.length === 0) {
      return successResponse(`Source "${sourceSlug}" publishes no resources.`);
    }
    const found = [
      resources.length > 0 ? plural(resources.length, 'resource') : '',
      resourceTemplates.length > 0 ? plural(resourceTemplates.length, 'resource template') : '',
    ].filter(Boolean).join(' and ');
    const howToRead = resourceTemplates.length > 0
      ? 'Read one with source_read_resource (for a template, fill in its {placeholders} to form the uri).'
      : 'Read one with source_read_resource.';
    const listing = {
      ...(resources.length > 0 ? { resources } : {}),
      ...(resourceTemplates.length > 0 ? { resourceTemplates } : {}),
    };
    return successResponse(
      `${found} from "${sourceSlug}"${truncated ? TRUNCATED_NOTE : ''}. ${howToRead}\n\n${JSON.stringify(listing, null, 2)}`
    );
  } catch (error) {
    return errorResponse(`Failed to list resources: ${toError(error)}`);
  }
}

// ============================================================
// source_read_resource
// ============================================================

export interface SourceReadResourceArgs {
  sourceSlug: string;
  uri: string;
}

export async function handleSourceReadResource(
  ctx: SessionToolContext,
  args: SourceReadResourceArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');
  const uri = args.uri?.trim();
  if (!uri) return errorResponse('uri is required. Use source_list_resources to find one.');

  try {
    return successResponse(await ctx.mcpSources.readResource(sourceSlug, uri));
  } catch (error) {
    return errorResponse(`Failed to read ${uri}: ${toError(error)}`);
  }
}

// ============================================================
// source_list_prompts
// ============================================================

export interface SourceListPromptsArgs {
  sourceSlug: string;
}

export async function handleSourceListPrompts(
  ctx: SessionToolContext,
  args: SourceListPromptsArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');

  try {
    const { prompts, truncated } = await ctx.mcpSources.listPrompts(sourceSlug);
    if (prompts.length === 0) {
      return successResponse(`Source "${sourceSlug}" publishes no prompts.`);
    }
    return successResponse(
      `${plural(prompts.length, 'prompt')} from "${sourceSlug}"${truncated ? TRUNCATED_NOTE : ''}. ` +
        `Get one with source_get_prompt, passing its required arguments.\n\n${JSON.stringify({ prompts }, null, 2)}`
    );
  } catch (error) {
    return errorResponse(`Failed to list prompts: ${toError(error)}`);
  }
}

// ============================================================
// source_get_prompt
// ============================================================

export interface SourceGetPromptArgs {
  sourceSlug: string;
  name: string;
  arguments?: Record<string, string>;
}

export async function handleSourceGetPrompt(
  ctx: SessionToolContext,
  args: SourceGetPromptArgs
): Promise<ToolResult> {
  if (!ctx.mcpSources) return errorResponse(MCP_SOURCES_UNAVAILABLE);
  const sourceSlug = args.sourceSlug?.trim();
  if (!sourceSlug) return errorResponse('sourceSlug is required.');
  const name = args.name?.trim();
  if (!name) return errorResponse('name is required. Use source_list_prompts to find one.');

  try {
    return successResponse(await ctx.mcpSources.getPrompt(sourceSlug, name, args.arguments));
  } catch (error) {
    return errorResponse(`Failed to get prompt "${name}": ${toError(error)}`);
  }
}
