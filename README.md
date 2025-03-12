# VS Code Extension for combining MDE + LLM-Codegeneration

Description: 

## Features

This VSCode extension allows for supplying Java method bodies from natural language specifications. The behavior
of the method to be implemented needs to be specified in a JavaDoc tag @prompt.

## Requirements

There are currently two options for connecting to a LLM.

### Llama.cpp

Please checkout, build and run the latest Llama.cpp version following the official documentation that can be found in the corresponding [GitHub repository](https://github.com/ggml-org/llama.cpp)

Download the desired language model of your choice from Huggingface. Please note that Llama.cpp requires the model to be in GGUF format!.
Start the provided llama-server (from the examples subdirectory) using your model, e.g.
```./build/bin/llama-server -m models/gte-Qwen2-7B-instruct.Q4_K_M.gguf -c 2048```

### Ollama

Download and run Ollama, or connect to a remote Ollama instance (settings can be accessed in the extension)

## Using the extension

Right click on a folder in your project that contains Java source files and run the Action "Process Java Files". 

Please note: running a LLM locally is significantly slower than obtaining responses from ChatGPT or other publicly hosted models. Depending on the number of your Java source files and the methods containing JavaDoc comments including the @prompt tag, processing all requests may take a considerable time.

## Tweaking the LLM

### Qwen2.5-Coder7b (running on local ollama)

System prompt:
You are an experienced Java programmer. I will ask you questions on how to implement the body of certain Java methods. In your answer, only give the statements for the method body. And output the raw data.
