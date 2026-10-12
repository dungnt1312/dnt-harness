---
description: Generate a video from a description, optionally animating an attached image
argument-hint: "<describe the video>"
allowed-tools: GenerateVideo
disable-model-invocation: true
---
The user ran /video to generate a video. Call the GenerateVideo tool with this description as the prompt, keeping the user's wording and intent:

$ARGUMENTS

Rules:
- If the description above is empty, do not call the tool: ask the user what video to create.
- If the user attached an image to this message, animate it: pass the `attachmentId` from its `[image attachment … attachmentId=…]` marker. Otherwise make a text-to-video call and pass neither `attachmentId` nor `path`.
- Pass `seconds` or `size` only when the user asked for a duration or a resolution (for example 8 seconds, 1280x720).
- Generation can take several minutes and the call waits for it. Do not start a second video while one is running.
- If GenerateVideo fails or is unavailable, tell the user the reason in one sentence. Do not retry on your own.
- After it succeeds the video is already shown in the chat. Reply with one short sentence and do not mention a file path, an id, or how to open it.
