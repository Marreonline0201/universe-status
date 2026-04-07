// MaterialGenerator.ts — Uses Claude API to parse natural language into compositions

import { type ElementName, ELEMENTS } from '../composition/PropertyCalculator'

export interface MaterialResult {
  name: string
  formula: string
  elements: Partial<Record<ElementName, number>>
  temperature: number
  state: 'solid' | 'liquid' | 'gas'
}

const SYSTEM_PROMPT = `You are a chemistry assistant for a physics simulator. When given a material name, return its elemental composition as mass fractions.

Available elements: ${ELEMENTS.join(', ')}

Respond in JSON only, no explanation:
{"name": "...", "formula": "...", "elements": {"Fe": 0.5, "C": 0.01, ...}, "temperature": 20, "state": "solid"}

Rules:
- Mass fractions must sum to 1.0
- Only use elements from the available list
- If an element isn't in the list, use the closest available substitute
- temperature in °C (room temp for solids, above melting point for liquids)
- state: what state the material is in at the given temperature`

export class MaterialGenerator {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generate(description: string): Promise<MaterialResult | null> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: description }],
        }),
      })

      if (!response.ok) {
        console.error('MaterialGenerator API error:', response.status, response.statusText)
        return null
      }

      const data = await response.json()
      const text = data.content?.[0]?.text
      if (!text) return null

      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = text.trim()
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim()
      }

      const parsed = JSON.parse(jsonStr) as MaterialResult

      // Validate elements — remove any not in our list
      for (const el of Object.keys(parsed.elements)) {
        if (!ELEMENTS.includes(el as ElementName)) {
          delete parsed.elements[el as ElementName]
        }
      }

      // Normalize fractions to sum to 1
      const total = Object.values(parsed.elements).reduce((s, v) => s + (v ?? 0), 0)
      if (total <= 0) return null
      for (const el of Object.keys(parsed.elements)) {
        parsed.elements[el as ElementName]! /= total
      }

      return parsed
    } catch (e) {
      console.error('MaterialGenerator error:', e)
      return null
    }
  }
}
