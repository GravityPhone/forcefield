# Forcefield Demo Studio

One-off local tool for producing the Forcefield demo video. Not part of the deployed app.

## Run

```
node demo-studio/server.mjs
```

Then open **http://localhost:4599** in your normal browser (Chrome/Edge — mic and
screen capture need a real tab, not an embedded pane). Needs `ffmpeg`/`ffprobe` on PATH.

## Workflow (per segment)

1. Pick a segment in the left rail. Edit its talking points if you want.
2. **Record VO take** — full-screen teleprompter; tap `Space` as you move to each
   talking point (the timing marks are saved with the take), `Esc` or Stop to finish.
3. **Record screen take** — pick the browser window showing forcefield.ninja and
   drive the app yourself. Optionally the selected VO take plays out loud while you
   record, so your driving paces to your narration.
4. Take as many of each as you like; radio-select the keeper, note/delete the rest.
5. **Build preview** to check the muxed segment.

Then upload an MP3 in the music card and hit **Assemble final video** →
`demo-studio/media/final.mp4` (concat of all ready segments, music ducked under VO,
corner labels per segment).

## Notes

- `project.json` (working state) and `media/` (all recordings/renders) are gitignored;
  `project.seed.json` is the fresh-start template. To reset: stop the server, delete
  `project.json` and `media/`, start again.
- Deleting a take in the UI removes it from the list only; the file stays in `media/`.
- Segment 1 (Hook) is a montage — record it last from your best material.
