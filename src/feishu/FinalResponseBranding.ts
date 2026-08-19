export const FINAL_RESPONSE_BRANDING =
  "> Powered by [AgentBot](https://bytedance.larkoffice.com/docx/UTukdYBopojSivxRVeUcCXTtnid)";
export const FINAL_RESPONSE_BRANDING_BLOCK = `----\n\n${FINAL_RESPONSE_BRANDING}`;

export function splitFinalResponseBranding(markdown: string): {
  content: string;
  branding?: string;
} {
  if (markdown === FINAL_RESPONSE_BRANDING_BLOCK) {
    return { content: "", branding: FINAL_RESPONSE_BRANDING };
  }

  const suffix = `\n\n${FINAL_RESPONSE_BRANDING_BLOCK}`;
  if (!markdown.endsWith(suffix)) return { content: markdown };
  return {
    content: markdown.slice(0, -suffix.length),
    branding: FINAL_RESPONSE_BRANDING,
  };
}
