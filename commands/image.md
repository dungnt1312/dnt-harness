---
description: Generate an image from a description
argument-hint: "<describe the image>"
allowed-tools: GenerateImage
disable-model-invocation: true
---
The user ran /image to generate an image. Call the GenerateImage tool with this description as the prompt, keeping the user's wording and intent:

$ARGUMENTS

Rules:
- If the description above is empty, do not call the tool: ask the user what image to create.
- Pass `size` only when the user asked for a size or an aspect ratio (for example 1024x1024, 1792x1024, 1024x1792).
- If GenerateImage fails or is unavailable, tell the user the reason in one sentence. Do not retry with a different prompt on your own.
- After it succeeds the image is already shown in the chat. Reply with one short sentence and do not mention a file path, an id, or how to open it.
