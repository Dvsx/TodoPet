export function coversWorkArea(
  bounds: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  slack = 16
): boolean {
  return bounds.x <= workArea.x + slack
    && bounds.y <= workArea.y + slack
    && bounds.width >= workArea.width - slack
    && bounds.height >= workArea.height - slack
}
