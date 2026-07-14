import * as fs from 'fs';
import * as path from 'path';

/**
 * Builds a map of class name -> fully qualified package path from all Java files.
 */
export function buildClassToPackageMap(folderPath: string): Map<string, string> {
    const map = new Map<string, string>();
    const javaFiles: string[] = [];
    const collectJavaFiles = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collectJavaFiles(fullPath);
            } else if (entry.name.endsWith(".java")) {
                javaFiles.push(fullPath);
            }
        }
    };
    collectJavaFiles(folderPath);

    for (const filePath of javaFiles) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const packageMatch = content.match(/^package\s+([\w.]+);/m);
            if (!packageMatch) {
                continue;
            }
            const pkg = packageMatch[1];
            const className = path.basename(filePath, '.java');
            map.set(className, pkg);
        } catch {
            // ignore
        }
    }

    return map;
}

/**
 * Well-known Java standard library packages for common classes used in generated code.
 */
const KNOWN_JAVA_PACKAGES: Record<string, string> = {
    'List': 'java.util',
    'ArrayList': 'java.util',
    'LinkedList': 'java.util',
    'Map': 'java.util',
    'HashMap': 'java.util',
    'LinkedHashMap': 'java.util',
    'Set': 'java.util',
    'HashSet': 'java.util',
    'LinkedHashSet': 'java.util',
    'Optional': 'java.util',
    'Collections': 'java.util',
    'Arrays': 'java.util',
    'Collectors': 'java.util.stream',
    'Stream': 'java.util.stream',
    'Comparator': 'java.util',
    'Objects': 'java.util',
    'Date': 'java.util',
    'UUID': 'java.util',
    'NoSuchElementException': 'java.util',
    'Iterator': 'java.util',
    'Collection': 'java.util',
    'Properties': 'java.util',
    'Scanner': 'java.util',
    'Random': 'java.util',
    'Locale': 'java.util',
    'Calendar': 'java.util',
    'GregorianCalendar': 'java.util',
    'Base64': 'java.util',
    'IllegalArgumentException': 'java.lang',
    'IllegalStateException': 'java.lang',
    'NullPointerException': 'java.lang',
    'RuntimeException': 'java.lang',
    'Exception': 'java.lang',
    'Throwable': 'java.lang',
    'String': 'java.lang',
    'Math': 'java.lang',
    'System': 'java.lang',
    'Integer': 'java.lang',
    'Long': 'java.lang',
    'Double': 'java.lang',
    'Boolean': 'java.lang',
    'Object': 'java.lang',
    'Override': 'java.lang',
    'Deprecated': 'java.lang',
    'SuppressWarnings': 'java.lang',
    'BigDecimal': 'java.math',
    'BigInteger': 'java.math',
    'RoundingMode': 'java.math',
    'Path': 'java.nio.file',
    'Files': 'java.nio.file',
    'Paths': 'java.nio.file',
    'IOException': 'java.io',
    'BufferedReader': 'java.io',
    'InputStream': 'java.io',
    'OutputStream': 'java.io',
    'FileReader': 'java.io',
    'FileWriter': 'java.io',
    'PrintWriter': 'java.io',
    'StringReader': 'java.io',
    'StringWriter': 'java.io',
    'InputStreamReader': 'java.io',
    'OutputStreamWriter': 'java.io',
    'BufferedWriter': 'java.io',
    'File': 'java.io',
    'SimpleDateFormat': 'java.text',
    'DecimalFormat': 'java.text',
    'ParseException': 'java.text',
    'Pattern': 'java.util.regex',
    'Matcher': 'java.util.regex',
    'Duration': 'java.time',
    'LocalDate': 'java.time',
    'LocalTime': 'java.time',
    'LocalDateTime': 'java.time',
    'Instant': 'java.time',
    'ZoneId': 'java.time',
    'ZonedDateTime': 'java.time',
    'Period': 'java.time',
    'DateTimeFormatter': 'java.time.format',
    'ConcurrentHashMap': 'java.util.concurrent',
    'CompletableFuture': 'java.util.concurrent',
    'ExecutorService': 'java.util.concurrent',
    'Executors': 'java.util.concurrent',
    'Future': 'java.util.concurrent',
    'CountDownLatch': 'java.util.concurrent',
    'Semaphore': 'java.util.concurrent',
    'BlockingQueue': 'java.util.concurrent',
    'LinkedBlockingQueue': 'java.util.concurrent',
    'ArrayBlockingQueue': 'java.util.concurrent',
    'ConcurrentMap': 'java.util.concurrent',
    'CopyOnWriteArrayList': 'java.util.concurrent',
    'AtomicInteger': 'java.util.concurrent.atomic',
    'AtomicLong': 'java.util.concurrent.atomic',
    'AtomicBoolean': 'java.util.concurrent.atomic',
    'AtomicReference': 'java.util.concurrent.atomic',
    'Timer': 'java.util',
    'TimerTask': 'java.util',
};

/**
 * Extracts all class-like identifiers from generated Java code.
 * Matches capitalized words that are not preceded by a dot (which would be a method call).
 */
function extractClassReferences(code: string): Set<string> {
    const result = new Set<string>();
    // Match capitalized identifiers that are not part of a fully qualified name
    // (i.e., not preceded by a dot)
    const regex = /(?<![.\w])([A-Z][a-zA-Z0-9_]*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(code)) !== null) {
        result.add(match[1]);
    }
    return result;
}

/**
 * Checks if a class name is already imported in the file content.
 */
function isAlreadyImported(fileContent: string, className: string): boolean {
    // Check if the class is already imported
    const importRegex = new RegExp(`import\\s+(?:static\\s+)?[\\w.]+\\.${className};`);
    if (importRegex.test(fileContent)) {
        return true;
    }
    // Check if the class is in the same package (no import needed)
    // We can't easily determine this, so we assume it's not
    // Check if the class is java.lang (auto-imported)
    if (KNOWN_JAVA_PACKAGES[className] === 'java.lang') {
        return true;
    }
    return false;
}

/**
 * Adds missing imports to a Java file after generated code has been inserted.
 *
 * @param filePath The Java file to process
 * @param generatedCode The code that was generated and inserted
 * @param folderPath The root folder to search for class definitions
 * @returns The list of imports that were added
 */
export function addMissingImports(filePath: string, generatedCode: string, folderPath: string): string[] {
    const addedImports: string[] = [];

    let fileContent: string;
    try {
        fileContent = fs.readFileSync(filePath, 'utf8');
    } catch {
        return addedImports;
    }

    // Build class -> package map from all Java files
    const classToPackage = buildClassToPackageMap(folderPath);

    // Extract class references from generated code
    const classRefs = extractClassReferences(generatedCode);

    // Find missing imports
    const missingImports: string[] = [];
    for (const className of classRefs) {
        // Skip if already imported
        if (isAlreadyImported(fileContent, className)) {
            continue;
        }

        // Look up package in project files
        const pkg = classToPackage.get(className);
        if (pkg) {
            missingImports.push(`import ${pkg}.${className};`);
            continue;
        }

        // Look up in known Java packages
        const knownPkg = KNOWN_JAVA_PACKAGES[className];
        if (knownPkg && knownPkg !== 'java.lang') {
            missingImports.push(`import ${knownPkg}.${className};`);
        }
    }

    if (missingImports.length === 0) {
        return addedImports;
    }

    // Deduplicate
    const uniqueImports = [...new Set(missingImports)];

    // Find the last import statement in the file
    const lastImportMatch = fileContent.match(/^import\s+[\w.]+;/gm);
    if (lastImportMatch && lastImportMatch.length > 0) {
        const lastImport = lastImportMatch[lastImportMatch.length - 1];
        const lastImportIndex = fileContent.lastIndexOf(lastImport);
        const insertPosition = lastImportIndex + lastImport.length;

        // Insert after the last import
        const newImports = uniqueImports.join('\n') + '\n';
        fileContent = fileContent.slice(0, insertPosition) + '\n' + newImports + fileContent.slice(insertPosition);
    } else {
        // No existing imports - insert after the package declaration
        const packageMatch = fileContent.match(/^package\s+[\w.]+;/m);
        if (packageMatch) {
            const insertPosition = packageMatch.index! + packageMatch[0].length;
            const newImports = '\n' + uniqueImports.join('\n') + '\n';
            fileContent = fileContent.slice(0, insertPosition) + newImports + fileContent.slice(insertPosition);
        }
    }

    fs.writeFileSync(filePath, fileContent, 'utf8');
    console.log(`[LLMProcessor] Added ${uniqueImports.length} missing imports: ${uniqueImports.join(', ')}`);
    return uniqueImports;
}
