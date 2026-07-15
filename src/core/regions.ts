export interface RegionInfo {
  key: string
  label: string
  apiEndpoint: string
}

export const CF_REGIONS: RegionInfo[] = [
  { key: 'cf-ap10', label: 'Asia Pacific (Australia)', apiEndpoint: 'https://api.cf.ap10.hana.ondemand.com' },
  { key: 'cf-ap11', label: 'Asia Pacific (Singapore)', apiEndpoint: 'https://api.cf.ap11.hana.ondemand.com' },
  { key: 'cf-ap12', label: 'Asia Pacific (Mumbai)', apiEndpoint: 'https://api.cf.ap12.hana.ondemand.com' },
  { key: 'cf-ap20', label: 'Asia Pacific (Seoul)', apiEndpoint: 'https://api.cf.ap20.hana.ondemand.com' },
  { key: 'cf-ap21', label: 'Asia Pacific (Osaka)', apiEndpoint: 'https://api.cf.ap21.hana.ondemand.com' },
  { key: 'cf-br10', label: 'South America (São Paulo)', apiEndpoint: 'https://api.cf.br10.hana.ondemand.com' },
  { key: 'cf-ca10', label: 'Canada (Montreal)', apiEndpoint: 'https://api.cf.ca10.hana.ondemand.com' },
  { key: 'cf-ch20', label: 'Switzerland (Zurich)', apiEndpoint: 'https://api.cf.ch20.hana.ondemand.com' },
  { key: 'cf-eu10', label: 'Europe (Frankfurt)', apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com' },
  { key: 'cf-eu11', label: 'Europe (London)', apiEndpoint: 'https://api.cf.eu11.hana.ondemand.com' },
  { key: 'cf-eu20', label: 'Europe (Amsterdam)', apiEndpoint: 'https://api.cf.eu20.hana.ondemand.com' },
  { key: 'cf-eu30', label: 'Europe (St. Leon Rot)', apiEndpoint: 'https://api.cf.eu30.hana.ondemand.com' },
  { key: 'cf-eu31', label: 'Europe (Rot, BLP)', apiEndpoint: 'https://api.cf.eu31.hana.ondemand.com' },
  { key: 'cf-in30', label: 'India (Hyderabad)', apiEndpoint: 'https://api.cf.in30.hana.ondemand.com' },
  { key: 'cf-jp10', label: 'Japan (Tokyo)', apiEndpoint: 'https://api.cf.jp10.hana.ondemand.com' },
  { key: 'cf-us10', label: 'US East (Ashburn)', apiEndpoint: 'https://api.cf.us10.hana.ondemand.com' },
  { key: 'cf-us20', label: 'US West (Sterling)', apiEndpoint: 'https://api.cf.us20.hana.ondemand.com' },
  { key: 'cf-us21', label: 'US West (Champaign)', apiEndpoint: 'https://api.cf.us21.hana.ondemand.com' },
  { key: 'cf-us30', label: 'US Central (Quincy)', apiEndpoint: 'https://api.cf.us30.hana.ondemand.com' },
  { key: 'cf-us31', label: 'US East (Quincy, BLP)', apiEndpoint: 'https://api.cf.us31.hana.ondemand.com' },
]

export function findRegion(apiEndpoint: string): RegionInfo | undefined {
  return CF_REGIONS.find(r => r.apiEndpoint === apiEndpoint)
}

export function apiToKey(apiEndpoint: string): string {
  const r = findRegion(apiEndpoint)
  return r ? r.key : apiEndpoint.replace(/^https:\/\/api\./, '').replace(/\.hana\.ondemand\.com$/, '')
}
