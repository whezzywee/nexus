export function resizeComposer(input: HTMLTextAreaElement, maximumHeight: number): void {
  input.style.height = "0px";
  const nextHeight = Math.min(input.scrollHeight, maximumHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maximumHeight ? "auto" : "hidden";
}
