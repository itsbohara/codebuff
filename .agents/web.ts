import type { AgentDefinition } from './types/agent-definition'

/**
 * Web Content Extractor Agent
 *
 * Extracts and returns content from a provided URL.
 * Useful for fetching documentation, READMEs, articles, or any web content.
 */
const definition: AgentDefinition = {
  id: 'webee',
  displayName: 'Webee',
  model: 'openrouter/kimi-k2.5',

  spawnerPrompt:
    'Extract content from a specific URL. Use when you need to fetch and read the content of a webpage, documentation, README, or any web resource.',

  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'The URL to extract content from (e.g., https://example.com/docs)',
    },
  },

  outputMode: 'last_message',
  includeMessageHistory: false,

  // Tools needed for URL content extraction
  toolNames: ['run_terminal_command'],

  systemPrompt: `You are a web content extraction specialist. Your purpose is to fetch and extract clean content from URLs provided by the user.

When given a URL:
1. Use run_terminal_command with curl to fetch the content
2. Clean up the output (remove HTML tags if needed, or return raw content)
3. Return the extracted content in a readable format

For HTML pages, focus on extracting the main content and removing navigation, ads, and scripts.
For raw text/markdown files (like GitHub raw URLs), return the content as-is.`,

  instructionsPrompt: `Extract content from the provided URL.

The user has provided a URL: "{{prompt}}"

Steps to extract the content:
1. Use run_terminal_command to fetch the URL content with curl
   - Use: curl -sL "<URL>" | head -c 50000 (to get up to 50KB of content)
   - For HTML pages, you can use: curl -sL "<URL>" | sed 's/<[^>]*>//g' | tr -s '\\n' '\\n' | head -c 30000

2. Process the output to make it readable:
   - If it's HTML: strip tags and extract meaningful text
   - If it's Markdown/text: return as-is
   - If it's JSON: format it nicely

3. Return the extracted content to the user.

Always return the full content when possible, or a meaningful excerpt if it's too long.`,

  handleSteps: function* ({ agentState, prompt, logger }) {
    const url = prompt?.trim()

    if (!url) {
      yield {
        toolName: 'set_output',
        input: {
          output:
            'Error: No URL provided. Please provide a URL to extract content from.',
        },
      }
      return
    }

    // Validate URL
    let validatedUrl: string
    try {
      const urlObj = new URL(url)
      validatedUrl = urlObj.toString()
    } catch {
      // If it's not a valid URL, try adding https:// prefix
      try {
        const urlWithProtocol = `https://${url}`
        const urlObj = new URL(urlWithProtocol)
        validatedUrl = urlObj.toString()
      } catch {
        yield {
          toolName: 'set_output',
          input: {
            output: `Error: Invalid URL format: "${url}". Please provide a valid URL (e.g., https://example.com)`,
          },
        }
        return
      }
    }

    logger.info({ url: validatedUrl }, 'Fetching content from URL')

    // Fetch the content using curl
    const { toolResult } = yield {
      toolName: 'run_terminal_command',
      input: {
        command: `curl -sL "${validatedUrl}" | head -c 100000`,
        timeout_seconds: 30,
      },
    }

    // Extract result from toolResult - run_terminal_command returns stdout, stderr, exitCode
    const result = (toolResult
      ?.filter((r) => r.type === 'json')
      ?.map((r) => r.value)?.[0] ?? {}) as {
      stdout: string | undefined
      stderr: string | undefined
      exitCode: number | undefined
      errorMessage: string | undefined
    }

    const output = result?.stdout
    const error = result?.errorMessage ?? result?.stderr

    if (error) {
      logger.error({ url: validatedUrl, error }, 'Failed to fetch URL')
      yield {
        toolName: 'set_output',
        input: {
          output: `Error fetching URL "${validatedUrl}": ${error}`,
        },
      }
      return
    }

    if (!output || output.trim().length === 0) {
      yield {
        toolName: 'set_output',
        input: {
          output: `No content found at URL: ${validatedUrl}`,
        },
      }
      return
    }

    logger.info(
      { url: validatedUrl, contentLength: output.length },
      'Successfully fetched content',
    )

    // Return the extracted content
    yield {
      toolName: 'set_output',
      input: {
        output: `Content from ${validatedUrl}:\n\n---\n\n${output}`,
      },
    }
  },
}

export default definition
