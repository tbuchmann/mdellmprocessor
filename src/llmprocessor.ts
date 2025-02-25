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
