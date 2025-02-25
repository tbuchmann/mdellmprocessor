import * as fs from 'fs';

export function processJavaFile(filePath: string) {
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

        // Find the next '{' after the JavaDoc
        const javadocEndIndex = match.index + match[0].length;
        const openingBraceIndex = content.indexOf('{', javadocEndIndex);

        if (openingBraceIndex !== -1) {
            // Insert the prompt content after '{'
            content = content.slice(0, openingBraceIndex + 1) +
                      "\n    " + promptContent +  // Adjust indentation if needed
                      content.slice(openingBraceIndex + 1);
        }
    }


    fs.writeFileSync(filePath, content, 'utf8');
}

function sendPrompt(prompt: string): string {
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
