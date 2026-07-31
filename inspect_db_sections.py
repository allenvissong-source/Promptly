from pathlib import Path
text = Path("src/lib/db.ts").read_text().splitlines()
for start, end in [(180, 360), (360, 620), (620, 840)]:
    print(f"--- lines {start}-{end} ---")
    for i in range(start - 1, min(end, len(text))):
        print(f"{i+1}: {text[i]}")
