/**
 * Real config-service responses, captured from
 * https://workbench.ondc.tech/config-service and trimmed for size.
 *
 * Trimming was limited to shortening prose, truncating base64 bodies and
 * dropping all but a few flows/steps — every field name, nesting level and
 * quirk (`extraSequence`, `payloadField`, `responseFor: null`, the
 * `{oldInputs:[…]}` input shape) is exactly what the service returns. Tests
 * built on invented shapes would pass while the real integration breaks.
 */

export const BUILDS_RESPONSE = [
  {
    key: "ONDC:FIS12",
    version: [
      {
        key: "2.3.0",
        usecase: ["BUSINESS LOAN", "LAMF LOAN", "PURCHASE FINANCE"],
      },
      {
        key: "2.0.3",
        usecase: ["GOLD LOAN", "PERSONAL LOAN"],
      },
      {
        key: "2.2.1",
        usecase: ["PURCHASE FINANCE"],
      },
    ],
  },
  {
    key: "ONDC:RET10",
    version: [
      {
        key: "1.2.5",
        usecase: ["GROCERY"],
      },
      {
        key: "1.2.0",
        usecase: ["GROCERY"],
      },
    ],
  },
] as const;

export const FLOWS_RESPONSE = {
  data: {
    flows: [
      {
        id: "Personal_Loan_Offline",
        description:
          "A personal loan origination flow enabling borrowers to search, apply, and track their application while lenders perform ",
        sequence: [
          {
            key: "search_personal_loan_3",
            type: "search",
            owner: "BAP",
            description:
              "The BAP initiates a search for personal loan foreclosure service providers in the specified geographic location, establi",
            expect: true,
            unsolicited: false,
            pair: "on_search_personal_loan_3",
            repeat: 1,
          },
          {
            key: "on_search_personal_loan_3",
            type: "on_search",
            owner: "BPP",
            description:
              "The BPP responds with a catalog of available personal loan foreclosure providers and their product offerings, including ",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "personal_loan_information_form",
            type: "HTML_FORM",
            owner: "BPP",
            description:
              "The BAP collects the borrower's personal, employment, and address verification information through an HTML form to enabl",
            label:
              "The BAP collects the borrower's personal, employment, and address verification information through an HTML form to enabl",
            unsolicited: false,
            pair: null,
            repeat: 1,
            input: [
              {
                name: "form_submission_id",
                label: "Enter Form Submission id",
                type: "HTML_FORM",
                reference: "$.reference_data.personal_loan_information_form",
              },
            ],
          },
          {
            key: "select_3_personal_loan_3",
            type: "select",
            owner: "BAP",
            description:
              "The BAP selects a specific personal loan product for foreclosure from the BPP and submits the borrower information neces",
            expect: false,
            unsolicited: false,
            pair: "on_select_3_personal_loan_3",
            repeat: 1,
            input: [
              {
                name: "fis12_personal_loan_select",
                type: "fis12_personal_loan_select",
                schema: {},
              },
            ],
          },
          {
            key: "on_select_3_personal_loan_3",
            type: "on_select",
            owner: "BPP",
            description:
              "The BPP confirms the borrower's selected personal loan option and responds with the finalized offer including principal ",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "Ekyc_details_verification_status",
            type: "DYNAMIC_FORM",
            owner: "BPP",
            description: "please add relevant description",
            label: "please add relevant description",
            unsolicited: false,
            pair: null,
            repeat: 1,
            input: [
              {
                name: "form_submission_id",
                label: "Enter form submission ID",
                type: "DYNAMIC_FORM",
                payloadField: "form_submission_id",
                reference: "$.reference_data.Ekyc_details_verification_status",
              },
            ],
          },
          {
            key: "on_status_kyc_verification",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP asynchronously notifies the BAP of the loan application's status as it progresses through offline verification a",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
            force_proceed: true,
          },
          {
            key: "status_personal_loan_3",
            type: "status",
            owner: "BAP",
            description:
              "The BAP requests the current status of the loan application from the BPP to monitor the progress of offline verification",
            expect: false,
            unsolicited: false,
            pair: "on_status_personal_loan_3",
            repeat: 1,
          },
          {
            key: "on_status_personal_loan_3",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP responds with the current status of the loan application to the BAP, conveying the progress of offline verificat",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_personal_loan_3_order_update",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP asynchronously transmits unsolicited status updates to the BAP conveying the loan application's progress through",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "confirm_personal_loan_3",
            type: "confirm",
            owner: "BAP",
            description:
              "The BAP confirms the borrower's loan foreclosure request to the BPP, formally committing to the negotiated early repayme",
            expect: false,
            unsolicited: false,
            pair: "on_confirm_personal_loan_3",
            repeat: 1,
          },
          {
            key: "on_confirm_personal_loan_3",
            type: "on_confirm",
            owner: "BPP",
            description:
              "The BPP confirms the borrower's partial prepayment request by returning the updated loan order with recalculated repayme",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_installment_1",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP proactively sends unsolicited status updates to the BAP tracking the borrower's loan application as it progresse",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_installment_2",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP proactively sends an unsolicited status update to the BAP regarding the personal loan application's progress thr",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_installment_3",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP sends an unsolicited status update to the BAP regarding the personal loan application's verification progress an",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_installment_4",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP sends an unsolicited status update to the BAP about the loan application's progress during offline verification ",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_installment_5",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP sends an unsolicited status update to the BAP communicating the outcome of its offline verification and underwri",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
        ],
        extraSequence: [],
        tags: ["WORKBENCH", "REPORTABLE"],
      },
      {
        id: "Personal_Loan_Dedupe_Check",
        description:
          "A borrower searches for and selects a personal loan product while the system verifies against existing loan records to p",
        sequence: [
          {
            key: "search_personal_loan_3",
            type: "search",
            owner: "BAP",
            description:
              "The BAP initiates a search request to identify existing personal loan records associated with the borrower, establishing",
            expect: true,
            unsolicited: false,
            pair: "on_search_personal_loan_3",
            repeat: 1,
          },
          {
            key: "on_search_personal_loan_3",
            type: "on_search",
            owner: "BPP",
            description:
              "The BPP responds with its personal loan product catalog and provides the intake form required to collect borrower inform",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "select_3_personal_loan_3",
            type: "select",
            owner: "BAP",
            description:
              "The BAP selects a specific personal loan offer and provider from the deduplicated search results, confirming which loan ",
            expect: false,
            unsolicited: false,
            pair: "on_select_3_personal_loan_3",
            repeat: 1,
            input: [
              {
                name: "fis12_personal_loan_select",
                type: "fis12_personal_loan_select",
                schema: {},
              },
            ],
          },
          {
            key: "on_select_3_personal_loan_3",
            type: "on_select",
            owner: "BPP",
            description:
              "The BPP acknowledges the BAP's loan product selection and responds with the confirmed order containing quote pricing, lo",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
          {
            key: "on_status_personal_loan_3_order_update",
            type: "on_status",
            owner: "BPP",
            description:
              "The BPP communicates the status of the completed personal loan dedupe verification to the BAP, confirming the borrower's",
            expect: false,
            unsolicited: true,
            pair: null,
            repeat: 1,
          },
          {
            key: "confirm_personal_loan_3",
            type: "confirm",
            owner: "BAP",
            description:
              "The BAP confirms the borrower's loan application containing the selected quote, fulfillment details, and order informati",
            expect: false,
            unsolicited: false,
            pair: "on_confirm_personal_loan_3",
            repeat: 1,
          },
          {
            key: "on_confirm_personal_loan_3",
            type: "on_confirm",
            owner: "BPP",
            description:
              "The BPP confirms the borrower's personal loan application and returns the finalized loan order containing the principal ",
            expect: false,
            unsolicited: false,
            pair: null,
            repeat: 1,
          },
        ],
        extraSequence: [],
        tags: ["WORKBENCH", "REPORTABLE"],
      },
    ],
  },
} as const;

export const MOCK_CONFIG_RESPONSE = {
  meta: {
    domain: "ONDC:FIS12",
    version: "2.0.3",
    flowId: "Personal_Loan_Offline",
    config_version: "0.0.0001",
    description:
      "A personal loan origination flow enabling borrowers to search, apply, and track their application while lenders perform offline verification and underwriting to deliver a lending decision.",
    use_case_id: "PERSONAL LOAN",
    flowName: "Personal Loan Offline",
  },
  transaction_data: {
    transaction_id: "37495a18-da5d-42d2-ad74-db69a22618fe",
    latest_timestamp: "1970-01-01T00:00:00.000Z",
    bap_id: "bap.example.com",
    bap_uri: "https://bap.example.com",
    bpp_id: "bpp.example.com",
    bpp_uri: "https://bpp.example.com",
  },
  steps: [
    {
      api: "search",
      action_id: "search_personal_loan_3",
      owner: "BAP",
      responseFor: null,
      unsolicited: false,
      description:
        "The BAP initiates a search for personal loan foreclosure service providers in the specified geographic location, establi",
      mock: {
        generate:
          "YXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoZGVmYXVsdFBheWxvYWQsIHNlc3Npb25E",
        validate:
          "LyoqCiAqIFZhbGlkYXRlcyB0aGUgaW5jb21pbmcgcmVxdWVzdCBwYXlsb2FkIGZv",
        requirements:
          "LyoqCiAqIENoZWNrcyBpZiB0aGUgcmVxdWlyZW1lbnRzIGZvciBwcm9jZWVkaW5n",
        defaultPayload: {
          context: {
            action: "search",
          },
        },
        saveData: {
          transactionId: "$.context.transaction_id",
          latestMessage_id: "$.context.message_id",
        },
        inputs: {},
      },
      examples: [
        {
          trimmed: true,
        },
      ],
    },
    {
      api: "on_search",
      action_id: "on_search_personal_loan_3",
      owner: "BPP",
      responseFor: "search_personal_loan_3",
      unsolicited: false,
      description:
        "The BPP responds with a catalog of available personal loan foreclosure providers and their product offerings, including ",
      mock: {
        generate:
          "YXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoZXhpc3RpbmdQYXlsb2FkLCBzZXNzaW9u",
        validate:
          "LyoqCiAqIFZhbGlkYXRlcyB0aGUgaW5jb21pbmcgcmVxdWVzdCBwYXlsb2FkIGZv",
        requirements:
          "LyoqCiAqIENoZWNrcyBpZiB0aGUgcmVxdWlyZW1lbnRzIGZvciBwcm9jZWVkaW5n",
        defaultPayload: {
          context: {
            action: "on_search",
          },
        },
        saveData: {
          transactionId: "$.context.transaction_id",
          latestMessage_id: "$.context.message_id",
        },
        inputs: {},
      },
      examples: [
        {
          trimmed: true,
        },
      ],
    },
    {
      api: "html_form",
      action_id: "personal_loan_information_form",
      owner: "BPP",
      responseFor: null,
      unsolicited: false,
      description:
        "The BAP collects the borrower's personal, employment, and address verification information through an HTML form to enabl",
      mock: {
        generate:
          "LyoqCiAqIEdlbmVyYXRlcyB0aGUgbW9jayBwYXlsb2FkIGZvciBhbiBBUEkgY2Fs",
        validate:
          "LyoqCiAqIFZhbGlkYXRlcyB0aGUgaW5jb21pbmcgcmVxdWVzdCBwYXlsb2FkIGZv",
        requirements:
          "LyoqCiAqIENoZWNrcyBpZiB0aGUgcmVxdWlyZW1lbnRzIGZvciBwcm9jZWVkaW5n",
        formHtml: "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVu",
        defaultPayload: {
          context: {
            action: "html_form",
          },
        },
        saveData: {},
        inputs: {
          oldInputs: [
            {
              name: "form_submission_id",
              label: "Enter Form Submission id",
              type: "HTML_FORM",
              reference: "$.reference_data.personal_loan_information_form",
            },
          ],
        },
      },
      examples: [
        {
          trimmed: true,
        },
      ],
    },
  ],
  transaction_history: [],
  helperLib: "LyoKCUN1c3RvbSBoZWxwZXIgZnVuY3Rpb25zIGF2YWlsYWJsZSBpbiBhbGwgbW9j",
  validationLib: "",
} as const;
