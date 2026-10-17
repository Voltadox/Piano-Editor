/** Background photos shipped with Keyfall (in public/backgrounds), all under the Unsplash License. */
export interface BackgroundPreset {
  file: string
  title: string
  photographer: string
  url: string
}

export const BACKGROUNDS: BackgroundPreset[] = [
  { file: 'redwood-shadows.jpg', title: 'Redwood Shadows', photographer: 'Spencer DeMera', url: 'https://unsplash.com/photos/a-dark-forest-filled-with-lots-of-trees-0aMeE7cHsLU' },
  { file: 'misty-pines.jpg', title: 'Misty Pines', photographer: 'Daniil Silantev', url: 'https://unsplash.com/photos/a-foggy-night-with-trees-in-the-distance-2XKR-38TxbU' },
  { file: 'milky-way-forest.jpg', title: 'Milky Way Forest', photographer: 'Braden Tavelli', url: 'https://unsplash.com/photos/silhouette-of-trees-during-nighttime-ldMfU7XzWlU' },
  { file: 'starlit-pines.jpg', title: 'Starlit Pines', photographer: 'Joshua Woroniecki', url: 'https://unsplash.com/photos/silhouette-of-trees-under-blue-sky-during-night-time-SkLSOR5r3nc' },
  { file: 'galaxy-lake.jpg', title: 'Galaxy Lake', photographer: 'Pascal Debrunner', url: 'https://unsplash.com/photos/milky-way-and-mountains-reflected-in-a-serene-lake-HUYPJupBvwE' },
  { file: 'aurora-pines.jpg', title: 'Aurora Pines', photographer: 'HyunKuk Kim', url: 'https://unsplash.com/photos/silhouette-of-trees-under-green-aurora-kRB26utONtw' },
  { file: 'starlit-valley-lake.jpg', title: 'Starlit Valley Lake', photographer: 'Zetong Li', url: 'https://unsplash.com/photos/mountains-stars-and-lake-reflect-in-a-beautiful-nightscape-aCusqffy5sY' },
  { file: 'blue-hour-peak.jpg', title: 'Blue Hour Peak', photographer: 'Martin Adams', url: 'https://unsplash.com/photos/the-silhouette-of-a-mountain-against-a-dark-blue-sky-G7sDNMQn_GA' }
]
