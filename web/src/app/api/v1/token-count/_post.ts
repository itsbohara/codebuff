import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { getErrorObject } from '@codebuff/common/util/error'
import { env } from '@codebuff/internal/env'
import { NextResponse } from 'next/server'
import { z } from 'zod/v4'

import { parseJsonBody, requireUserFromApiKey } from '../_helpers'

import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type {
  Logger,
  LoggerWithContextFn,
} from '@codebuff/common/types/contracts/logger'
import type { NextRequest } from 'next/server'

const tokenCountRequestSchema = z.object({
  messages: z.array(z.any()),
  system: z.string().optional(),
  model: z.string().optional(),
})

type TokenCountRequest = z.infer<typeof tokenCountRequestSchema>

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'

export async function postTokenCount(params: {
  req: NextRequest
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  logger: Logger
  loggerWithContext: LoggerWithContextFn
  trackEvent: TrackEventFn
  fetch: typeof globalThis.fetch
}) {
  const {
    req,
    getUserInfoFromApiKey,
    logger: baseLogger,
    loggerWithContext,
    trackEvent,
    fetch,
  } = params

  // Authenticate user
  const userResult = await requireUserFromApiKey({
    req,
    getUserInfoFromApiKey,
    logger: baseLogger,
    loggerWithContext,
    trackEvent,
    authErrorEvent: AnalyticsEvent.TOKEN_COUNT_AUTH_ERROR,
  })

  if (!userResult.ok) {
    return userResult.response
  }

  const { userId, logger } = userResult.data

  // Parse request body
  const bodyResult = await parseJsonBody({
    req,
    schema: tokenCountRequestSchema,
    logger,
    trackEvent,
    validationErrorEvent: AnalyticsEvent.TOKEN_COUNT_VALIDATION_ERROR,
  })

  if (!bodyResult.ok) {
    return bodyResult.response
  }

  const { messages, system, model } = bodyResult.data

  try {
    // Use OpenRouter for all token counting - supports all models through a single API
    const inputTokens = await countTokensViaOpenRouter({
      messages,
      system,
      model: model ?? DEFAULT_MODEL,
      fetch,
      logger,
    })

    logger.info({
      userId,
      messageCount: messages.length,
      hasSystem: !!system,
      model: model ?? DEFAULT_MODEL,
      tokenCount: inputTokens,
      provider: 'openrouter',
    },
      `Token count: ${inputTokens}`
    )

    return NextResponse.json({ inputTokens })
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), userId },
      'Failed to count tokens',
    )

    return NextResponse.json(
      { error: 'Failed to count tokens' },
      { status: 500 },
    )
  }
}

// Buffer to add to token count for estimated counting fallback
const TOKEN_ESTIMATE_BUFFER = 0.1

// Get the base URL for OpenRouter-compatible API
const OPENROUTER_BASE_URL = env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

/**
 * Count tokens using OpenRouter's API
 * OpenRouter provides a unified token counting endpoint for all models
 */
export async function countTokensViaOpenRouter(params: {
  messages: TokenCountRequest['messages']
  system: string | undefined
  model: string
  fetch: typeof globalThis.fetch
  logger: Logger
}): Promise<number> {
  const { messages, system, model, fetch, logger } = params

  // Build the request body for OpenRouter
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    })),
  }

  if (system) {
    body.system = system
  }

  const baseUrl = OPENROUTER_BASE_URL.replace(/\/$/, '') // Remove trailing slash if present
  const response = await fetch(`${baseUrl}/auth/limits`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.OPEN_ROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    logger.warn(
      { status: response.status, model },
      'OpenRouter auth check failed, falling back to estimation',
    )
    // Fallback to estimation
    return estimateTokenCount(messages, system)
  }

  // OpenRouter doesn't have a direct token count endpoint, so we use estimation
  // The auth/limits endpoint tells us rate limits but not token counts for specific requests
  return estimateTokenCount(messages, system)
}

/**
 * Estimate token count based on character count
 * This is a rough estimate: ~4 characters per token for most models
 */
function estimateTokenCount(
  messages: TokenCountRequest['messages'],
  system: string | undefined,
): number {
  let totalChars = 0

  if (system) {
    totalChars += system.length
  }

  for (const message of messages) {
    if (typeof message.content === 'string') {
      totalChars += message.content.length
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          totalChars += part.text.length
        } else if (part.type === 'json' && part.value) {
          totalChars += JSON.stringify(part.value).length
        }
      }
    }
  }

  // Rough estimate: 4 characters per token, plus buffer
  return Math.ceil((totalChars / 4) * (1 + TOKEN_ESTIMATE_BUFFER))
}

export type ResponsesApiContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

export type ResponsesApiInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer'; content: string | ResponsesApiContentPart[] }
  | { type: 'function_call'; id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export function convertToResponsesApiInput(
  messages: TokenCountRequest['messages'],
): ResponsesApiInputItem[] {
  const input: ResponsesApiInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const content = buildMessageContent(message.content)
      if (content) {
        input.push({ type: 'message', role: 'developer', content })
      }
      continue
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? 'unknown',
        output: formatToolContent(message.content),
      })
      continue
    }

    if (message.role === 'user') {
      const content = buildMessageContent(message.content)
      if (content) {
        input.push({ type: 'message', role: 'user', content })
      }
      continue
    }

    if (message.role === 'assistant') {
      const content = buildMessageContent(message.content)
      if (content) {
        input.push({ type: 'message', role: 'assistant', content })
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'tool-call') {
            input.push({
              type: 'function_call',
              id: part.toolCallId ?? 'unknown',
              name: part.toolName,
              arguments: JSON.stringify(part.input ?? {}),
            })
          }
        }
      }
    }
  }

  return input
}

function buildMessageContent(
  content: unknown,
): string | ResponsesApiContentPart[] | null {
  if (typeof content === 'string') return content || null
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content)
    return text || null
  }

  const hasImages = content.some(
    (part) => part.type === 'image' && typeof part.image === 'string' && part.image,
  )

  if (!hasImages) {
    const text = extractTextParts(content)
    return text || null
  }

  const parts: ResponsesApiContentPart[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      parts.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'json') {
      const text = typeof part.value === 'string' ? part.value : JSON.stringify(part.value)
      if (text) {
        parts.push({ type: 'input_text', text })
      }
    } else if (part.type === 'image') {
      const imageUrl = toImageUrl(part.image, part.mediaType)
      if (imageUrl) {
        parts.push({ type: 'input_image', image_url: imageUrl })
      }
    }
  }

  return parts.length > 0 ? parts : null
}

function toImageUrl(image: unknown, mediaType?: string): string | null {
  if (typeof image !== 'string' || !image) return null
  if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('data:')) {
    return image
  }
  return `data:${mediaType ?? 'image/png'};base64,${image}`
}

function extractTextParts(content: Array<Record<string, unknown>>): string {
  const parts: string[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    } else if (part.type === 'json') {
      parts.push(typeof part.value === 'string' ? part.value : JSON.stringify(part.value))
    }
  }
  return parts.join('\n')
}


export function convertToAnthropicMessages(
  messages: TokenCountRequest['messages'],
): Array<{ role: 'user' | 'assistant'; content: any }> {
  const result: Array<{ role: 'user' | 'assistant'; content: any }> = []

  for (const message of messages) {
    // Skip system messages - they're handled separately
    if (message.role === 'system') {
      continue
    }

    // Handle tool messages by converting to user messages with tool_result
    if (message.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? 'unknown',
            content: formatToolContent(message.content),
          },
        ],
      })
      continue
    }

    // Handle user and assistant messages
    if (message.role === 'user' || message.role === 'assistant') {
      const content = convertContentToAnthropic(message.content, message.role)
      if (content) {
        result.push({
          role: message.role,
          content,
        })
      }
    }
  }

  return result
}

export function convertContentToAnthropic(
  content: any,
  role: 'user' | 'assistant',
): any {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content)
  }

  const anthropicContent: any[] = []

  for (const part of content) {
    if (part.type === 'text') {
      const text = part.text.trim()
      if (text) {
        anthropicContent.push({ type: 'text', text })
      }
    } else if (part.type === 'tool-call' && role === 'assistant') {
      anthropicContent.push({
        type: 'tool_use',
        id: part.toolCallId ?? 'unknown',
        name: part.toolName,
        input: part.input ?? {},
      })
    } else if (part.type === 'image') {
      // Handle image content - the image field can be base64 data or a URL string
      const imageData = part.image
      if (typeof imageData === 'string' && imageData) {
        if (
          imageData.startsWith('http://') ||
          imageData.startsWith('https://')
        ) {
          // URL-based image
          anthropicContent.push({
            type: 'image',
            source: {
              type: 'url',
              url: imageData,
            },
          })
        } else {
          // Base64 encoded image data
          anthropicContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType ?? 'image/png',
              data: imageData,
            },
          })
        }
      }
      // Skip images without valid data
    } else if (part.type === 'json') {
      const text =
        typeof part.value === 'string'
          ? part.value.trim()
          : JSON.stringify(part.value).trim()
      if (text) {
        anthropicContent.push({
          type: 'text',
          text,
        })
      }
    }
  }

  return anthropicContent.length > 0 ? anthropicContent : undefined
}

export function formatToolContent(content: any): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'json') return JSON.stringify(part.value)
        return JSON.stringify(part)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}
