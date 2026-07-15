// Mock CF CLI output for testing
export const MOCK_ORGS_OUTPUT = `
Getting orgs as admin...

name
test-org
dev-org
prod-org
`

export const MOCK_SPACES_OUTPUT = `
Getting spaces in org test-org as admin...

name
dev
staging
prod
`

export const MOCK_APPS_OUTPUT = `
Getting apps in org test-org / space dev as admin...

name                    requested state   instances   memory   disk   urls
my-app                  started           1/1         256M     1G     my-app.cfapps.us10.hana.ondemand.com
my-api                  started           2/2         512M     1G     my-api.cfapps.us10.hana.ondemand.com
my-worker               stopped           0/1         128M     1G
`

export const MOCK_TARGET_OUTPUT = `
API endpoint:   https://api.cf.us10.hana.ondemand.com
API version:    3.158.0
User:           admin@example.com
Org:            test-org
Space:          dev
`

export const MOCK_EVENTS_OUTPUT = `
Getting events for app my-app...

time                        actor                     event               description
2024-01-01T00:00:00.00Z     admin@example.com         audit.app.start     Started app
2024-01-01T01:00:00.00Z     admin@example.com         audit.app.ssh       SSH access enabled
2024-01-01T02:00:00.00Z     admin@example.com         audit.app.restart   App restarted
`
