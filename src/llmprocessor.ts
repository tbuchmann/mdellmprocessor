import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { start } from 'repl';

const LLAMA_SERVER_URL = "http://127.0.0.1:8080/completion";

export function processJavaFile(filePath: string, folderPath: string) {
    /*
    let content = fs.readFileSync(filePath, 'utf8');

    const javadocRegex = /\/\*\*[\s\S]*?@prompt\s+(.+?)[\s\S]*?\*\//g;
    let match;

    while ((match = javadocRegex.exec(content)) !== null) {
        const promptContent = match[1].trim();

        // Find the next '{' after this JavaDoc
        const javadocEndIndex = match.index + match[0].length;
        const openingBraceIndex = content.indexOf('{', javadocEndIndex);

        if (openingBraceIndex !== -1) {
            // Insert the prompt content after '{'
            content = content.slice(0, openingBraceIndex + 1) +
                      "\n    " + promptContent +  // Adjust indentation if needed
                      content.slice(openingBraceIndex + 1);
        }
    }
    */
    let content = fs.readFileSync(filePath, 'utf8');

    const javadocRegex = /\/\*\*[\s\S]*?@prompt\s+([\s\S]*?)\*\//g;
    let match;

    while ((match = javadocRegex.exec(content)) !== null) {
        let promptContent = match[1].trim();
        
        // Handle multi-line @prompt (stopping at '*/')
        promptContent = promptContent.split("\n").map(line => line.trim().replace(/^\*/, "").trim()).join(" ");

        // Find the next '//generated start' after the JavaDoc
        const javadocEndIndex = match.index + match[0].length;
        const startGenIndex = content.indexOf('//generated start', javadocEndIndex);

        // if (openingBraceIndex !== -1) {
        //     // Insert the prompt content after '{'
        //     content = content.slice(0, openingBraceIndex + 1) +
        //               "\n    " + promptContent +  // Adjust indentation if needed
        //               content.slice(openingBraceIndex + 1);
        // }

        // Extract the method name before the '{'
        const methodRegex = /([a-zA-Z0-9_<>\[\]]+)\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/g;
        let methodMatch;
        let methodName = "UnknownMethod";

        while ((methodMatch = methodRegex.exec(content)) !== null) {
            if (methodMatch.index > javadocEndIndex) {
                methodName = methodMatch[2]; // Extracts method name
                break;
            }
        }

        // Read all Java files in the folder as context
        let contextText = getAllJavaFilesContent(folderPath);

        // Send prompt + context to Llama server
        //sendToLlama(promptContent, methodName, contextText);
        sendToAI(promptContent, contextText, methodName).then((llmGen) => {
            if (startGenIndex !== -1) { 
                // Insert the generated code between '//generated start' and '//generated end'
                const endGenIndex = content.indexOf('//generated end', startGenIndex);
                if (endGenIndex !== -1) {
                    content = content.slice(0, startGenIndex + '//generated start'.length) +
                            "\n" + llmGen + "\n" +
                            content.slice(endGenIndex);
                }
                fs.writeFileSync(filePath, content, 'utf8');
            }
        });
    }    
    
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
  
  if (serverType === "llama") {
      return await sendToLlama(prompt, context, methodName, config.get<string>("llamaEndpoint", "http://localhost:8080/completion"));
  } else if (serverType === "ollama") {
      return await sendToOllama(prompt, context, methodName, config.get<string>("ollamaEndpoint", "http://localhost:11434/api/generate"));
  } else {
      vscode.window.showErrorMessage("Invalid AI server type selected.");
      return "";
  }
}

async function sendToLlama(prompt: string, context: string, methodName: string, endpoint: string) : Promise<string> {
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

async function sendToOllama(prompt: string, context: string, methodName: string, endpoint: string) : Promise<string> {
  const jsonRequest = JSON.stringify({
      model: "qwen2.5-coder:7b",  // Change model as needed
      prompt: `Context:\n${context}\n\nQuestion:\n${prompt}\n\nSource code only, without any explanations and only the body of the method. Don't repeat the Java source code. Please give me only the generated lines.`,
      stream: false
  });
  console.log(jsonRequest);
    try {
      const response = await axios.post(endpoint, {
          model: "qwen2.5-coder:7b",  // Change model as needed
          system: `You are an experienced Java programmer. I will ask you questions on how to implement the body of certain Java methods. In your answer, only give the statements for the method body. And output the raw data.`,
          prompt: `Context:\n${context}\n\nQuestion:\n${prompt}\n\nSource code only, without any explanations and only the body of the method. Don't repeat the Java source code. Please give me only the generated lines. Raw data only, no markdown.`,
          stream: false
      });
      //processResponse(response.data.response, methodName);
      vscode.window.showInformationMessage(`Ollama Response for ${methodName}: ${response.data.response}`);
      return response.data.response;
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
