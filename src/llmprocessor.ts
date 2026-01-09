import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { start } from 'repl';
import { Ollama } from 'ollama';

//const LLAMA_SERVER_URL = "http://127.0.0.1:8080/completion";

export async function processJavaFile(filePath: string, folderPath: string) {
    let content = fs.readFileSync(filePath, 'utf8');

    const javadocRegex = /\/\*\*[\s\S]*?@prompt\s+([\s\S]*?)\*\//g;
    let match;
    
    // Collect all matches first
    const matches: Array<{
        promptContent: string;
        javadocEndIndex: number;
        startGenIndex: number;
        endGenIndex: number;
        methodName: string;
    }> = [];

    while ((match = javadocRegex.exec(content)) !== null) {
        let promptContent = match[1].trim();
        
        // Handle multi-line @prompt (stopping at '*/')
        promptContent = promptContent.split("\n").map(line => line.trim().replace(/^\*/, "").trim()).join(" ");

        // Find the next '//generated start' after the JavaDoc
        const javadocEndIndex = match.index + match[0].length;
        const startGenIndex = content.indexOf('//generated start', javadocEndIndex);

        // Extract the method name before the '{'
        const methodRegex = /([a-zA-Z0-9_<>\[\]]+)\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/g;
        let methodMatch;
        let methodName = "UnknownMethod";

        while ((methodMatch = methodRegex.exec(content)) !== null) {
            if (methodMatch.index > javadocEndIndex) {
                methodName = methodMatch[2];
                break;
            }
        }

        if (startGenIndex !== -1) {
            const endGenIndex = content.indexOf('//generated end', startGenIndex);
            if (endGenIndex !== -1) {
                matches.push({
                    promptContent,
                    javadocEndIndex,
                    startGenIndex,
                    endGenIndex,
                    methodName
                });
            }
        }
    }

    // Process matches sequentially with progress tracking
    const totalMethods = matches.length;
    
    if (totalMethods === 0) {
        vscode.window.showInformationMessage("No methods with @prompt found in file.");
        return;
    }

    // Read all Java files in the folder as context (do this once)
    let contextText = getAllJavaFilesContent(folderPath);

    // Show progress while processing
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Processing Java methods (0/${totalMethods})`,
            cancellable: true,
        },
        async (progress, token) => {
            for (let i = 0; i < matches.length; i++) {
                // Check if cancellation was requested
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage("Method processing cancelled by user.");
                    break;
                }

                const matchItem = matches[i];
                
                // Update progress
                const message = `Processing method: ${matchItem.methodName} (${i + 1}/${totalMethods})`;
                progress.report({ message, increment: (100 / totalMethods) * i });

                // Wait for the AI response
                const llmGen = await sendToAI(matchItem.promptContent, contextText, matchItem.methodName);

                if (llmGen) {
                    // Re-read content to account for previous insertions
                    content = fs.readFileSync(filePath, 'utf8');

                    // TODO: check if the answer contains ```java ... ``` and extract only the code part
                    // For now, we assume the response is raw code
                    
                    // Recalculate indices based on updated content
                    const updatedStartGenIndex = content.indexOf('//generated start', matchItem.javadocEndIndex);
                    if (updatedStartGenIndex !== -1) {
                        const updatedEndGenIndex = content.indexOf('//generated end', updatedStartGenIndex);
                        if (updatedEndGenIndex !== -1) {
                            content = content.slice(0, updatedStartGenIndex + '//generated start'.length) +
                                    "\n" + llmGen + "\n" +
                                    content.slice(updatedEndGenIndex);
                            fs.writeFileSync(filePath, content, 'utf8');
                        }
                    }
                }

                // Update final progress
                if (i === matches.length - 1) {
                    progress.report({ message: `Completed: ${matchItem.methodName}`, increment: 100 });
                }
            }
        }
    );

    vscode.window.showInformationMessage(`Successfully processed ${totalMethods} method(s) in ${filePath}`);
}
/*
function sendPrompt(prompt: string, method: string): string {
    let promptResult = '';

    const testMsg = async(prompt: string) => {
        try {
            let response = await fetch("http://127.0.0.1:8080/completion", {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                prompt,
                n_predict: 30,
                stream: true,
              }),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }

              if (!response.body) {
                throw new Error('Response body is null');
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let result = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                result += decoder.decode(value, { stream: true });

                const lines = result.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data:')) {
                    try {
                      const json = JSON.parse(line.substring(5).trim());
                      console.log(json.content);
                      let token = json.content;                      
                    } catch (e) {
                        console.error('Error parsing JSON:', e);
                    }
                }
                result = lines[lines.length - 1];
              }
            }
            promptResult = result;
        } catch (error) {
            console.error('Error:', error);
        }
    };

    return promptResult;
}
*/
function getAllJavaFilesContent(folderPath: string): string {
    const files = fs.readdirSync(folderPath).filter(file => file.endsWith(".java"));
    return files.map(file => fs.readFileSync(path.join(folderPath, file), 'utf8')).join("\n\n");
}

function getSystemPrompt(): string {
  const config = vscode.workspace.getConfiguration("aiServer");
  return config.get<string>("systemPrompt", "You are an experienced Java programmer. I will ask you questions on how to implement the body of certain Java methods. In your answer, only give the statements for the method body. And output the raw data.");
}

/*
async function sendToLlama(prompt: string, method: string, context: string) {
    let request = `Please give me a Java implementation for the method ${method}. The following prompt describes the desired behavior:\n\n${prompt}\n\nContext:\n\n${context}\n\nSource code only, without any explanations and only the body of the method. Don't repeat the Java source code. Please give me only the generated lines.`;
    try {
        const response = await axios.post(LLAMA_SERVER_URL, {
            prompt: request,
            context: context,
            temperature: 0.7,
            max_tokens: 256
        });

        vscode.window.showInformationMessage("Llama Response: " + response.data.content);
    } catch (error) {
        vscode.window.showErrorMessage("Error communicating with Llama server: " + error);
    }
}
*/

async function sendToAI(prompt: string, context: string, methodName: string) : Promise<string> {
  const config = vscode.workspace.getConfiguration("aiServer");
  const serverType = config.get<string>("type", "llama");
  const llmModel = config.get<string>("model", "qwen2.5-coder:7b");
  
  if (serverType === "llama") {
      return await sendToLlama(prompt, context, methodName, config.get<string>("llamaEndpoint", "http://localhost:8080/completion"), llmModel);
  } else if (serverType === "ollama") {
      const apiApproach = config.get<string>("ollamaApiApproach", "generate");
      const endpoint = config.get<string>("ollamaEndpoint", "http://localhost:11434/api/generate");
      
      if (apiApproach === "chat") {
          return await sendToOllamaChat(prompt, context, methodName, endpoint, llmModel);
      } else {
          return await sendToOllama(prompt, context, methodName, endpoint, llmModel);
      }
  } else {
      vscode.window.showErrorMessage("Invalid AI server type selected.");
      return "";
  }
}

async function sendToLlama(prompt: string, context: string, methodName: string, endpoint: string, llmmodel: string) : Promise<string> {
  try {
      const response = await axios.post(endpoint, {
          prompt: prompt,
          context: context,
          temperature: 0.7,
          max_tokens: 256
      });

      vscode.window.showInformationMessage(`Llama Response for ${methodName}: ${response.data.text}`);
      return response.data.text;
  } catch (error: any) {
      handleRequestError(error, "Llama.cpp");
      return "";
  }
}

async function sendToOllama(prompt: string, context: string, methodName: string, endpoint: string, llmmodel: string) : Promise<string> {
  try {
      // Initialize Ollama client - endpoint should be the base URL (e.g., http://localhost:11434)
      const baseUrl = endpoint.replace('/api/generate', ''); // Remove the endpoint path if present
      const ollama = new Ollama({ host: baseUrl });
      
      const systemPrompt = getSystemPrompt();
      const userPrompt = `Context:\n${context}\n\nQuestion:\n${prompt}\n\nSource code only, without any explanations and only the body of the method. Don't repeat the Java source code. Please give me only the generated lines. Raw data only, no markdown.`;
      
      // Use Ollama library to generate response
      const response = await ollama.generate({
          model: llmmodel,
          prompt: userPrompt,
          system: systemPrompt,
          stream: false,
      });
      
      const generatedText = response.response || '';
      vscode.window.showInformationMessage(`Ollama Response for ${methodName}: ${generatedText}`);
      return generatedText;
  } catch (error: any) {
      handleRequestError(error, "Ollama");
      return "";
  }
}

async function sendToOllamaChat(prompt: string, context: string, methodName: string, endpoint: string, llmmodel: string) : Promise<string> {
  try {
      // Initialize Ollama client - endpoint should be the base URL (e.g., http://localhost:11434)
      const baseUrl = endpoint.replace('/api/generate', ''); // Remove the endpoint path if present
      const ollama = new Ollama({ host: baseUrl });
      
      const systemPrompt = getSystemPrompt();
      
      // Use Ollama chat API with structured messages
      const response = await ollama.chat({
          model: llmmodel,
          messages: [
              {
                  role: 'system',
                  content: systemPrompt
              },
              {
                  role: 'user',
                  content: `Here is the codebase context:\n\n${context}\n\nImplement the method: ${methodName}\n\nRequirements:\n${prompt}\n\nProvide ONLY the method body code without explanations.`
              }
          ],
          stream: false,
      });
      
      const generatedText = response.message?.content || '';
      vscode.window.showInformationMessage(`Ollama Response for ${methodName}: ${generatedText}`);
      return generatedText;
  } catch (error: any) {
      handleRequestError(error, "Ollama");
      return "";
  }
}

function handleRequestError(error: any, serverName: string) {
  if (error.response) {
      vscode.window.showErrorMessage(`${serverName} API Error: ${error.response.status} - ${error.response.data}`);
  } else if (error.request) {
      vscode.window.showErrorMessage(`${serverName} API is unreachable. Check the server URL.`);
  } else {
      vscode.window.showErrorMessage(`Error sending request to ${serverName}: ${error.message}`);
  }
}

/*
function processResponse(response: any, methodName: string) {
    // Assuming the response is a string containing the generated method body
    const generatedCode = response.trim();

    // Display the generated code in a VSCode information message
    vscode.window.showInformationMessage(`Generated code for ${methodName}:\n${generatedCode}`);
}
*/
