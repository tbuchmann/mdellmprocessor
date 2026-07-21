import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LogEntry {
    timestamp: string;
    className: string;
    methodName: string;
    mode: string;
    prompt: string;
    response: string;
    status: 'success' | 'failed' | 'placeholder' | 'invalid';
    error?: string;
    usage?: TokenUsage;
    attempt: number;
}

export class GenerationLogger {
    private logFile: string;
    private usageFile: string;
    private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    private methodCount = 0;
    private failureCount = 0;

    constructor() {
        const logDir = this.getLogDirectory();
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const timestamp = this.getTimestampForFilename();
        this.logFile = path.join(logDir, `mdellm-${timestamp}.log`);
        this.usageFile = path.join(logDir, `mdellm-${timestamp}.usage.json`);
    }

    private getLogDirectory(): string {
        const config = vscode.workspace.getConfiguration("aiServer");
        const configured = config.get<string>("logDirectory", "");
        if (configured && configured.trim().length > 0) {
            return configured;
        }
        // Default: workspace root + /mdellm-logs
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
            return path.join(workspaceFolder, 'mdellm-logs');
        }
        return path.join(require('os').homedir(), 'mdellm-logs');
    }

    private getTimestampForFilename(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    private getTimestamp(): string {
        return new Date().toISOString();
    }

    log(entry: LogEntry): void {
        const lines: string[] = [];
        lines.push(`========================================`);
        lines.push(`Timestamp: ${entry.timestamp}`);
        lines.push(`Class: ${entry.className}`);
        lines.push(`Method: ${entry.methodName}`);
        lines.push(`Mode: ${entry.mode}`);
        lines.push(`Attempt: ${entry.attempt}`);
        lines.push(`Status: ${entry.status}`);
        if (entry.error) {
            lines.push(`Error: ${entry.error}`);
        }
        if (entry.usage) {
            lines.push(`Tokens: prompt=${entry.usage.promptTokens}, completion=${entry.usage.completionTokens}, total=${entry.usage.totalTokens}`);
        }
        lines.push(`--- Prompt ---`);
        lines.push(entry.prompt);
        lines.push(`--- Response ---`);
        lines.push(entry.response);
        if (entry.usage) {
            lines.push(`--- Token Usage ---`);
            lines.push(`Prompt tokens: ${entry.usage.promptTokens}`);
            lines.push(`Completion tokens: ${entry.usage.completionTokens}`);
            lines.push(`Total tokens: ${entry.usage.totalTokens}`);
        }
        lines.push('');
        fs.appendFileSync(this.logFile, lines.join('\n') + '\n', 'utf8');

        // Track usage
        if (entry.usage) {
            this.totalUsage.promptTokens += entry.usage.promptTokens;
            this.totalUsage.completionTokens += entry.usage.completionTokens;
            this.totalUsage.totalTokens += entry.usage.totalTokens;
        }
        this.methodCount++;
        if (entry.status !== 'success') {
            this.failureCount++;
        }
    }

    addUsage(usage: TokenUsage): void {
        this.totalUsage.promptTokens += usage.promptTokens;
        this.totalUsage.completionTokens += usage.completionTokens;
        this.totalUsage.totalTokens += usage.totalTokens;
    }

    getUsage(): TokenUsage & { methodCount: number; failureCount: number } {
        return {
            ...this.totalUsage,
            methodCount: this.methodCount,
            failureCount: this.failureCount,
        };
    }

    saveUsageSummary(): void {
        const summary = {
            timestamp: this.getTimestamp(),
            totalUsage: this.totalUsage,
            methodCount: this.methodCount,
            failureCount: this.failureCount,
        };
        fs.writeFileSync(this.usageFile, JSON.stringify(summary, null, 2), 'utf8');
    }

    getLogFile(): string {
        return this.logFile;
    }
}

// Global instance
let logger: GenerationLogger | null = null;

export function getLogger(): GenerationLogger {
    if (!logger) {
        logger = new GenerationLogger();
    }
    return logger;
}

export function resetLogger(): void {
    if (logger) {
        logger.saveUsageSummary();
    }
    logger = null;
}

/**
 * Extracts token usage from an Ollama response.
 */
export function extractOllamaUsage(response: any): TokenUsage | undefined {
    const promptTokens = response?.prompt_eval_count ?? response?.promptEvalCount ?? 0;
    const completionTokens = response?.eval_count ?? response?.evalCount ?? 0;
    if (promptTokens === 0 && completionTokens === 0) {
        return undefined;
    }
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
    };
}

/**
 * Extracts token usage from an OpenAI-compatible response.
 */
export function extractOpenAIUsage(response: any): TokenUsage | undefined {
    const usage = response?.data?.usage;
    if (!usage) {
        return undefined;
    }
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    if (promptTokens === 0 && completionTokens === 0) {
        return undefined;
    }
    return {
        promptTokens,
        completionTokens,
        totalTokens: (usage.total_tokens ?? (promptTokens + completionTokens)),
    };
}
