export function appendGeneratedImageMarkdown(finalResponse: string, imagePaths: string[]): string {
  const text = finalResponse.trim();
  const normalizedText = text.replaceAll("\\", "/");
  const images = [...new Set(imagePaths.map((imagePath) => imagePath.trim().replaceAll("\\", "/")).filter(Boolean))]
    .filter((imagePath) => !normalizedText.includes(imagePath));
  if (images.length === 0) return text;
  const imageMarkdown = images.map((imagePath, index) =>
    `![生成图片 ${index + 1}](<${imagePath}>)`).join("\n\n");
  return text ? `${text}\n\n${imageMarkdown}` : imageMarkdown;
}
