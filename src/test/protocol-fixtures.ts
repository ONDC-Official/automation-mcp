/**
 * A real `GET /protocol/spec/ONDC:FIS12/2.0.3` response, trimmed.
 *
 * Captured from the live config-service, then reduced — **never rewritten**.
 * Every field name, nesting level and type is exactly what the service
 * returns, including the two things that bite:
 *
 * - `meta.errorCodes[].code` is a **number** here. `ONDC:RET11/1.2.5`
 *   publishes the same field as a **string**. Both are live; the ingest
 *   normalises, and `protocol.bundle.test.ts` pins both directions.
 * - `validations` nests one level deeper than it reads:
 *   `validations.validations._TESTS_`.
 *
 * What was reduced, and how:
 *
 * - `flows[]` cut to three, and each `config` replaced by a stub. The stub is
 *   deliberately **kept rather than deleted**: `UpstreamSpecFlow` is the thing
 *   that has to strip it, and a fixture with no config could not tell us
 *   whether it does.
 * - Per-action maps cut to `search` / `on_search` / `confirm` / `on_confirm`.
 * - `meta.paths` keeps **only `/search`**, whole and verbatim — one real
 *   inlined schema is all the schema resource needs, and 8.6 KB against the
 *   41.7 KB all four would cost. It leaves the other three actions with no
 *   published schema, which is faithful (several builds define actions that
 *   `paths` does not describe) and exercises that branch for free.
 * - `meta.supportedActions`, `meta.apiProperties` and `meta.errorCodes` are
 *   **whole**. They are what the graph tools are tested against, and a trimmed
 *   graph would be a graph that does not exist.
 * - Field trees cut to five leaves per action; rule rows to four; docs and
 *   rule bodies truncated with a marker, the way `ondc-fixtures.ts` truncates
 *   base64.
 *
 * This build's graph is deliberately narrow — FIS12 publishes no self-looping
 * action and no `transaction_partner`. That is faithful, and it is why the
 * graph *semantics* (fan-out, unsolicited callbacks, echo contracts) are
 * pinned in `protocol.graph.test.ts` against literals taken from
 * `ONDC:TRV11/2.0.1` instead. A unit test may invent; a fixture may not.
 */
export const SPEC_RESPONSE = {
  "meta": {
    "paths": {
      "/search": {
        "post": {
          "operationId": "search",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "context": {
                      "type": "object",
                      "properties": {
                        "domain": {
                          "type": "string"
                        },
                        "action": {
                          "type": "string"
                        },
                        "timestamp": {
                          "type": "string"
                        },
                        "transaction_id": {
                          "type": "string"
                        },
                        "message_id": {
                          "type": "string"
                        },
                        "bap_id": {
                          "type": "string"
                        },
                        "bap_uri": {
                          "type": "string"
                        },
                        "ttl": {
                          "type": "string"
                        },
                        "bpp_id": {
                          "type": "string"
                        },
                        "bpp_uri": {
                          "type": "string"
                        },
                        "version": {
                          "type": "string"
                        },
                        "location": {
                          "type": "object",
                          "properties": {
                            "country": {
                              "type": "object",
                              "properties": {
                                "code": {
                                  "type": "string"
                                }
                              }
                            },
                            "city": {
                              "type": "object",
                              "properties": {
                                "code": {
                                  "type": "string"
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "message": {
                      "type": "object",
                      "properties": {
                        "intent": {
                          "type": "object",
                          "properties": {
                            "category": {
                              "type": "object",
                              "properties": {
                                "descriptor": {
                                  "type": "object",
                                  "properties": {
                                    "code": {
                                      "type": "string"
                                    }
                                  }
                                }
                              }
                            },
                            "payment": {
                              "type": "object",
                              "properties": {
                                "collected_by": {
                                  "type": "string"
                                },
                                "tags": {
                                  "type": "array",
                                  "items": {
                                    "type": "object",
                                    "properties": {
                                      "descriptor": {
                                        "type": "object",
                                        "properties": {
                                          "code": {
                                            "type": "string"
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            },
                            "tags": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "descriptor": {
                                    "type": "object",
                                    "properties": {
                                      "code": {
                                        "type": "string"
                                      },
                                      "name": {
                                        "type": "string"
                                      }
                                    }
                                  },
                                  "display": {
                                    "type": "boolean"
                                  },
                                  "list": {
                                    "type": "array",
                                    "items": {
                                      "type": "object",
                                      "properties": {
                                        "descriptor": {
                                          "type": "object",
                                          "properties": {
                                            "code": {
                                              "type": "string"
                                            }
                                          }
                                        },
                                        "value": {
                                          "type": "string"
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Synchronous ACK/NACK response",
              "content": {
                "application/json": {
                  "schema": {
                    "type": "object",
                    "properties": {
                      "message": {
                        "type": "object",
                        "properties": {
                          "ack": {
                            "properties": {
                              "status": {
                                "enum": [
                                  "ACK",
                                  "NACK"
                                ]
                              },
                              "tags": {
                                "description": "A list of tags containing any additional information sent along with the Acknowledgement.",
                                "type": "array",
                                "items": {
                                  "description": "A collection of tag objects with group level attributes. For detailed documentation on the Tags and Tag Groups schema go to https://github.com/beckn/protocol-specifications/discussions/316",
                                  "type": "object",
                                  "additionalProperties": false,
                                  "properties": {
                                    "display": {
                                      "description": "Indicates the display properties of the tag group. If display is set to false, then the group will not be displayed. If it is set to true, it should be displayed. However, group-level display properties can be overriden by individual tag-level display property. As this schema is purely for catalog display purposes, it is not recommended to send this value during search.",
                                      "type": "boolean",
                                      "default": true
                                    },
                                    "descriptor": {
                                      "description": "Description of the TagGroup, can be used to store detailed information.",
                                      "properties": {
                                        "name": {
                                          "type": "string"
                                        },
                                        "code": {
                                          "type": "string"
                                        },
                                        "short_desc": {
                                          "type": "string"
                                        },
                                        "long_desc": {
                                          "type": "string"
                                        },
                                        "additional_desc": {
                                          "type": "object",
                                          "additionalProperties": false,
                                          "properties": {
                                            "url": {
                                              "type": "string"
                                            },
                                            "content_type": {
                                              "type": "string",
                                              "enum": [
                                                "text/plain",
                                                "text/html",
                                                "application/json"
                                              ]
                                            }
                                          }
                                        },
                                        "media": {
                                          "type": "array",
                                          "items": {
                                            "description": "This object contains a url to a media file.",
                                            "type": "object",
                                            "additionalProperties": false,
                                            "properties": {
                                              "mimetype": {
                                                "description": "indicates the nature and format of the document, file, or assortment of bytes. MIME types are defined and standardized in IETF's RFC 6838",
                                                "type": "string"
                                              },
                                              "url": {
                                                "description": "The URL of the file",
                                                "type": "string",
                                                "format": "uri"
                                              },
                                              "signature": {
                                                "description": "The digital signature of the file signed by the sender",
                                                "type": "string"
                                              },
                                              "dsa": {
                                                "description": "The signing algorithm used by the sender",
                                                "type": "string"
                                              }
                                            }
                                          }
                                        },
                                        "images": {
                                          "type": "array",
                                          "items": {
                                            "description": "Describes an image",
                                            "type": "object",
                                            "additionalProperties": false,
                                            "properties": {
                                              "url": {
                                                "description": "URL to the image. This can be a data url or an remote url",
                                                "type": "string",
                                                "format": "uri"
                                              },
                                              "size_type": {
                                                "description": "The size of the image. The network policy can define the default dimensions of each type",
                                                "type": "string",
                                                "enum": [
                                                  "xs",
                                                  "sm",
                                                  "md",
                                                  "lg",
                                                  "xl",
                                                  "custom"
                                                ]
                                              },
                                              "width": {
                                                "description": "Width of the image in pixels",
                                                "type": "string"
                                              },
                                              "height": {
                                                "description": "Height of the image in pixels",
                                                "type": "string"
                                              }
                                            }
                                          }
                                        }
                                      },
                                      "type": "object"
                                    },
                                    "list": {
                                      "description": "An array of Tag objects listed under this group. This property can be set by BAPs during search to narrow the `search` and achieve more relevant results. When received during `on_search`, BAPs must render this list under the heading described by the `name` property of this schema.",
                                      "type": "array",
                                      "items": {
                                        "description": "Describes a tag. This is used to contain extended metadata. This object can be added as a property to any schema to describe extended attributes. For BAPs, tags can be sent during search to optimize and filter search results. BPPs can use tags to index their catalog to allow better search functionality. Tags are sent by the BPP as part of the catalog response in the `on_search` callback. Tags are also meant for display purposes. Upon receiving a tag, BAPs are meant to render them as name-value pairs. This is particularly useful when rendering tabular information about a product or service.",
                                        "type": "object",
                                        "additionalProperties": false,
                                        "properties": {
                                          "descriptor": {
                                            "description": "Description of the Tag, can be used to store detailed information.",
                                            "properties": {
                                              "name": {
                                                "type": "string"
                                              },
                                              "code": {
                                                "type": "string"
                                              },
                                              "short_desc": {
                                                "type": "string"
                                              },
                                              "long_desc": {
                                                "type": "string"
                                              },
                                              "additional_desc": {
                                                "type": "object",
                                                "additionalProperties": false,
                                                "properties": {
                                                  "url": {
                                                    "type": "string"
                                                  },
                                                  "content_type": {
                                                    "type": "string",
                                                    "enum": [
                                                      "text/plain",
                                                      "text/html",
                                                      "application/json"
                                                    ]
                                                  }
                                                }
                                              },
                                              "media": {
                                                "type": "array",
                                                "items": {
                                                  "description": "This object contains a url to a media file.",
                                                  "type": "object",
                                                  "additionalProperties": false,
                                                  "properties": {
                                                    "mimetype": {
                                                      "description": "indicates the nature and format of the document, file, or assortment of bytes. MIME types are defined and standardized in IETF's RFC 6838",
                                                      "type": "string"
                                                    },
                                                    "url": {
                                                      "description": "The URL of the file",
                                                      "type": "string",
                                                      "format": "uri"
                                                    },
                                                    "signature": {
                                                      "description": "The digital signature of the file signed by the sender",
                                                      "type": "string"
                                                    },
                                                    "dsa": {
                                                      "description": "The signing algorithm used by the sender",
                                                      "type": "string"
                                                    }
                                                  }
                                                }
                                              },
                                              "images": {
                                                "type": "array",
                                                "items": {
                                                  "description": "Describes an image",
                                                  "type": "object",
                                                  "additionalProperties": false,
                                                  "properties": {
                                                    "url": {
                                                      "description": "URL to the image. This can be a data url or an remote url",
                                                      "type": "string",
                                                      "format": "uri"
                                                    },
                                                    "size_type": {
                                                      "description": "The size of the image. The network policy can define the default dimensions of each type",
                                                      "type": "string",
                                                      "enum": [
                                                        "xs",
                                                        "sm",
                                                        "md",
                                                        "lg",
                                                        "xl",
                                                        "custom"
                                                      ]
                                                    },
                                                    "width": {
                                                      "description": "Width of the image in pixels",
                                                      "type": "string"
                                                    },
                                                    "height": {
                                                      "description": "Height of the image in pixels",
                                                      "type": "string"
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "type": "object"
                                          },
                                          "value": {
                                            "description": "The value of the tag. This set by the BPP and rendered as-is by the BAP.",
                                            "type": "string"
                                          },
                                          "display": {
                                            "description": "This value indicates if the tag is intended for display purposes. If set to `true`, then this tag must be displayed. If it is set to `false`, it should not be displayed. This value can override the group display value.",
                                            "type": "boolean"
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            },
                            "description": "Describes the acknowledgement sent in response to an API call. If the implementation uses HTTP/S, then Ack must be returned in the same session. Every API call to a BPP must be responded to with an Ack whether the BPP intends to respond with a callback or not. This has one property called `status` that indicates the status of the Acknowledgement.",
                            "type": "object"
                          }
                        },
                        "required": [
                          "ack"
                        ]
                      },
                      "error": {
                        "description": "Describes an error object that is returned by a BAP, BPP or BG as a response or callback to an action by another network participant. This object is sent when any request received by a network participant is unacceptable. This object can be sent either during Ack or with the callback.",
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "code": {
                            "type": "string",
                            "description": "Standard error code. For full list of error codes, refer to docs/protocol-drafts/BECKN-005-ERROR-CODES-DRAFT-01.md of this repo\""
                          },
                          "paths": {
                            "type": "string",
                            "description": "Path to json schema generating the error. Used only during json schema validation errors"
                          },
                          "message": {
                            "type": "string",
                            "description": "Human readable message describing the error. Used mainly for logging. Not recommended to be shown to the user."
                          }
                        }
                      }
                    },
                    "required": [
                      "message"
                    ]
                  }
                }
              }
            }
          }
        }
      }
    },
    "domain": "ONDC:FIS12",
    "version": "2.0.3",
    "title": "ONDC Specification",
    "description": "ONDC Specification",
    "usecases": [
      "GOLD LOAN",
      "PERSONAL LOAN"
    ],
    "usecaseStatus": [
      {
        "usecase": "GOLD LOAN",
        "status": "DRAFT"
      },
      {
        "usecase": "PERSONAL LOAN",
        "status": "DRAFT"
      }
    ],
    "supportedActions": {
      "null": [
        "search",
        "select"
      ],
      "search": [
        "on_search"
      ],
      "on_search": [
        "select"
      ],
      "select": [
        "on_select",
        "select",
        "status",
        "on_status"
      ],
      "on_select": [
        "init",
        "select",
        "on_status",
        "status"
      ],
      "init": [
        "on_init",
        "status",
        "on_status"
      ],
      "on_init": [
        "confirm",
        "init",
        "on_status",
        "status"
      ],
      "confirm": [
        "on_confirm",
        "on_status",
        "status"
      ],
      "on_confirm": [
        "update",
        "on_update",
        "on_status",
        "status",
        "issue"
      ],
      "update": [
        "on_update",
        "on_status",
        "status"
      ],
      "on_update": [
        "update",
        "on_update",
        "status",
        "on_status"
      ],
      "status": [
        "on_status",
        "status"
      ],
      "on_status": [
        "status",
        "on_status",
        "init",
        "update",
        "confirm",
        "issue"
      ],
      "issue": [
        "on_issue",
        "issue",
        "on_update",
        "on_status",
        "on_confirm",
        "on_issue_status",
        "update",
        "status"
      ],
      "on_issue": [
        "issue",
        "on_issue",
        "on_status",
        "on_issue_status",
        "update",
        "on_update",
        "issue_status",
        "status"
      ],
      "on_issue_status": [
        "on_issue",
        "issue",
        "on_update",
        "update",
        "issue_status",
        "on_issue_status",
        "on_status",
        "status"
      ],
      "issue_status": [
        "on_issue",
        "on_issue_status",
        "on_status",
        "status"
      ]
    },
    "apiProperties": {
      "search": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_search": {
        "async_predecessor": "search",
        "transaction_partner": [
          "search"
        ]
      },
      "select": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_select": {
        "async_predecessor": null,
        "transaction_partner": [
          "select"
        ]
      },
      "init": {
        "async_predecessor": null,
        "transaction_partner": [
          "on_select"
        ]
      },
      "on_init": {
        "async_predecessor": "init",
        "transaction_partner": [
          "init"
        ]
      },
      "confirm": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_confirm": {
        "async_predecessor": "confirm",
        "transaction_partner": [
          "confirm"
        ]
      },
      "update": {
        "async_predecessor": null,
        "transaction_partner": [
          "on_confirm"
        ]
      },
      "on_update": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "status": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_status": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "issue": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_issue": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "issue_status": {
        "async_predecessor": null,
        "transaction_partner": []
      },
      "on_issue_status": {
        "async_predecessor": null,
        "transaction_partner": []
      }
    },
    "errorCodes": [
      {
        "Event": "Application submittion failure",
        "Description": "Buyer application could not submit the loan application to the lender/s",
        "From": "BAP",
        "code": 80101
      },
      {
        "Event": "AA consent creation failure",
        "Description": "Lender could not create data fetch consent on account agreegator",
        "From": "BPP",
        "code": 80201
      },
      {
        "Event": "AA data pull failure",
        "Description": "Lender could not retrieve bank statement from the AA",
        "From": "BPP",
        "code": 80202
      },
      {
        "Event": "Offer return failure",
        "Description": "Lenders could not return loan offers to the buyer app",
        "From": "BPP",
        "code": 80203
      },
      {
        "Event": "Offer acceptance failure",
        "Description": "Buyer application could not submit user selected offer to the lender ",
        "From": "BAP",
        "code": 80102
      },
      {
        "Event": "Individual KYC failure",
        "Description": "Entity KYC failed on lender's platform - no retry",
        "From": "BPP",
        "code": 80204
      },
      {
        "Event": "Entity KYC failure",
        "Description": "Entity KYC failures where retry should be performed",
        "From": "BPP",
        "code": 80205
      },
      {
        "Event": "Disbursment account sharing failure",
        "Description": "Buyer app could not submit the disbursment account details",
        "From": "BAP",
        "code": 80103
      },
      {
        "Event": "Disbursment account verification failure",
        "Description": "Lender could not verify the disbursment account details",
        "From": "BPP",
        "code": 80206
      },
      {
        "Event": "Repayment setup failure",
        "Description": "Repayment setup failed on lender's platform",
        "From": "BPP",
        "code": 80207
      },
      {
        "Event": "Loan agreement sharing failure",
        "Description": "Lender could not share the loan agreement",
        "From": "BPP",
        "code": 80208
      },
      {
        "Event": "Loan agreement signing failure - Aadhar eSign",
        "Description": "Aadhar eSign failed while signing the loan agreement",
        "From": "BPP",
        "code": 80209
      },
      {
        "Event": "Monitoring consent creation failure",
        "Description": "Lender could not create account monitoring consent",
        "From": "BPP",
        "code": 80210
      },
      {
        "Event": "Monitoring consent approval failure",
        "Description": "Lender could not retrieve account monitoring consent",
        "From": "BPP",
        "code": 80211
      },
      {
        "Event": "Loan disbursal failure",
        "Description": "Lender could not disburse the loan amount",
        "From": "BAP",
        "code": 80104
      },
      {
        "Event": "Payment initiation failure",
        "Description": "Payment initiation failed on the buyer app (lender couldn't return the payment link for ex)",
        "From": "BPP",
        "code": 80212
      },
      {
        "Event": "Payment completion failure",
        "Description": "Payment completion failed on the lender's platform",
        "From": "BPP",
        "code": 80213
      },
      {
        "Event": "Timeout: The request or operation timed out.",
        "Description": "Response from seller app outside of TTL or vice versa",
        "From": "BPP",
        "code": 80214
      },
      {
        "Event": "General Error: An unspecified error occurred.",
        "Description": "General ",
        "From": "BPP/BAP",
        "code": 80215
      },
      {
        "Event": "Invalid Input: User input is not valid.",
        "Description": "Incorrect PAN etc.",
        "From": "BPP",
        "code": 80216
      },
      {
        "Event": "Missing Data: Required data is missing.",
        "Description": "Form submission without mandatory details",
        "From": "BPP/BAP",
        "code": 80217
      },
      {
        "Event": "Data Validation Failed: Input data failed validation checks.",
        "Description": "no description provided",
        "From": "BPP",
        "code": 80218
      },
      {
        "Event": "Service Unavailable: The service is temporarily unavailable.",
        "Description": "Form hosted by the seller is unavailable",
        "From": "BPP",
        "code": 80219
      },
      {
        "Event": "File Not Found: The requested file does not exist.",
        "Description": "Invoice based loans has GST reports to be uploaded",
        "From": "BPP",
        "code": 80220
      },
      {
        "Event": "3001 - File Upload Failed: An error occurred while uploading a file.",
        "Description": "Invoice based loans has GST reports to be uploaded",
        "From": "BAP",
        "code": 80105
      },
      {
        "Event": "File Format Not Supported: The uploaded file format is not supported.",
        "Description": "Invoice based loans has GST reports to be uploaded",
        "From": "BPP",
        "code": 80221
      },
      {
        "Event": "File Size Exceeded: The uploaded file exceeds size limits.",
        "Description": "Invoice based loans has GST reports to be uploaded",
        "From": "BPP",
        "code": 80222
      },
      {
        "Event": "API Rate Limit Exceeded",
        "Description": "The rate limit for an external API has been exceeded.",
        "From": "BPP",
        "code": 80223
      },
      {
        "Event": "AA drop off due to buffering time",
        "Description": "Application could not be processed at Lender's end due to buffering issues.",
        "From": "BPP",
        "code": 80224
      },
      {
        "Event": "Pincode Issue",
        "Description": "No. of applications with Pin Code not serviceable issue.",
        "From": "BPP",
        "code": 80225
      },
      {
        "Event": "CIBIL rejection",
        "Description": "No. of applications with CIBIL rejection issue.",
        "From": "BPP",
        "code": 80226
      },
      {
        "Event": "Rejected due to % or limits",
        "Description": "No. of applications with limit issue in init API.",
        "From": "BPP",
        "code": 80227
      },
      {
        "Event": "Lender Policy rejection",
        "Description": "It includes rejection due to Lender policy terms.",
        "From": "BPP",
        "code": 80228
      },
      {
        "Event": "Report not received from Bureau",
        "Description": "Bureau Report not parsed.",
        "From": "BPP",
        "code": 80229
      },
      {
        "Event": "Account agreegator ID is required.",
        "Description": "Lender could not process as Account agreegator ID is rquired.",
        "From": "BPP",
        "code": 80230
      }
    ],
    "buildHash": "8eb5e1b4daca42d2465254b53401337c5ac128818e0d9135b2d2f6c655170595",
    "ingestedAt": "2026-09-02T08:57:12.608Z",
    "components": null
  },
  "docs": [
    {
      "slug": "overview",
      "order": 0,
      "content": "# ONDC:FIS12 2.0.3 \u2014 Overview\n\n## Summary\nThis domain enables credit products on ONDC, specifically gold loans and personal loans. It lets users discover and access loan offers from multiple lenders through a buyer app, compare terms, and complete their loan journey end-to-end with real-time updates from the lender.\n\n## Sector & Purpose\n**Sector**: Financial services, specifically consumer credit.\n\n**Problem solved**: Users need a way to discover, compare, and apply for gold loans and personal loans without visiting multiple lenders independently. This domain brings lending products into the O\n\n(fixture: truncated)"
    },
    {
      "slug": "references",
      "order": 1,
      "content": "# ONDC:FIS12 2.0.3 \u2014 References\n\nAdd links and references here.\n"
    },
    {
      "slug": "release-notes",
      "order": 2,
      "content": "# ONDC:FIS12 2.0.3 \u2014 Release Notes\n\nList notable changes in this version.\n"
    },
    {
      "slug": "xinput-form-response",
      "order": 3,
      "content": "# XInput\n\nThis XInput schema facilitates seamless communication between buyers and sellers by allowing the exchange of additional information through forms.\nSellers can request specific details using custom forms, and buyers respond with the necessary information, ensuring a smooth transaction process.\nThe differentiation in MIME types and additional settings, such as resubmit and multiple submissions, adds flexibility to the form interaction between participants.\n\n## Seller-Side Form:\n\n```\n{\n  \"xinput\": {\n    \"head\": {\n      \"descriptor\": {\n        \"name\": \"Form Details\"\n      },\n      \"index\n\n(fixture: truncated)"
    }
  ],
  "flows": [
    {
      "domain": "ONDC:FIS12",
      "flowId": "Personal_Loan_Offline",
      "usecase": "PERSONAL LOAN",
      "version": "2.0.3",
      "description": "A personal loan origination flow enabling borrowers to search, apply, and track their application while lender",
      "tags": [
        "WORKBENCH",
        "REPORTABLE"
      ],
      "config": {
        "meta": {
          "order": 0
        },
        "steps": [],
        "note": "fixture: truncated. Must never survive ingest."
      }
    },
    {
      "domain": "ONDC:FIS12",
      "flowId": "Personal_Loan_Single_Redirection",
      "usecase": "PERSONAL LOAN",
      "version": "2.0.3",
      "description": "A borrower discovers and selects a personal loan offer within an ONDC marketplace, then completes the full loa",
      "tags": [
        "WORKBENCH",
        "REPORTABLE"
      ],
      "config": {
        "meta": {
          "order": 0
        },
        "steps": [],
        "note": "fixture: truncated. Must never survive ingest."
      }
    },
    {
      "domain": "ONDC:FIS12",
      "flowId": "Personal_Loan_Dedupe_Check",
      "usecase": "PERSONAL LOAN",
      "version": "2.0.3",
      "description": "A borrower searches for and selects a personal loan product while the system verifies against existing loan re",
      "tags": [
        "WORKBENCH",
        "REPORTABLE"
      ],
      "config": {
        "meta": {
          "order": 0
        },
        "steps": [],
        "note": "fixture: truncated. Must never survive ingest."
      }
    }
  ],
  "validationTable": {
    "domain": "ONDC:FIS12",
    "version": "2.0.3",
    "ingestedAt": "2026-09-02T08:57:13.088Z",
    "table": {
      "search": {
        "action": "search",
        "codeName": "L1validations",
        "numLeafTests": 27,
        "rows": [
          {
            "rowType": "group",
            "name": "**SEARCH_CONTEXT**",
            "group": "",
            "scope": "",
            "description": "Sub-tests: CONTEXT_REQUIRED, CONTEXT_ENUM, CONTEXT_REGEX",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "group",
            "name": "**CONTEXT_REQUIRED**",
            "group": "SEARCH_CONTEXT",
            "scope": "",
            "description": "Sub-tests: REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE, REQUIRED_CONTEXT_LOCATION_CITY_CODE, REQUIRED_CONTEXT_DOMAIN, REQUIRED_CONTEXT_TIMESTAMP, REQUIRED_CONTEXT_BAP_ID, REQUIRED_CONTEXT_BAP_URI, REQUIRED_CONTEXT_BPP_ID, REQUIRED_CONTEXT_BPP_URI, REQUIRED_CONTEXT_TRANSACTION_ID, REQUIRED_CONTEXT_MESSAGE_ID, REQUIRED_CONTEXT_VERSION, REQUIRED_CONTEXT_TTL",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
            "group": "SEARCH_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.country.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
            "group": "SEARCH_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.city.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          }
        ]
      },
      "on_search": {
        "action": "on_search",
        "codeName": "L1validations",
        "numLeafTests": 56,
        "rows": [
          {
            "rowType": "group",
            "name": "**ON_SEARCH_CONTEXT**",
            "group": "",
            "scope": "",
            "description": "Sub-tests: CONTEXT_REQUIRED, CONTEXT_ENUM, CONTEXT_REGEX",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "group",
            "name": "**CONTEXT_REQUIRED**",
            "group": "ON_SEARCH_CONTEXT",
            "scope": "",
            "description": "Sub-tests: REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE, REQUIRED_CONTEXT_LOCATION_CITY_CODE, REQUIRED_CONTEXT_DOMAIN, REQUIRED_CONTEXT_TIMESTAMP, REQUIRED_CONTEXT_BAP_ID, REQUIRED_CONTEXT_BAP_URI, REQUIRED_CONTEXT_BPP_ID, REQUIRED_CONTEXT_BPP_URI, REQUIRED_CONTEXT_TRANSACTION_ID, REQUIRED_CONTEXT_MESSAGE_ID, REQUIRED_CONTEXT_VERSION, REQUIRED_CONTEXT_TTL",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
            "group": "ON_SEARCH_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.country.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
            "group": "ON_SEARCH_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.city.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          }
        ]
      },
      "confirm": {
        "action": "confirm",
        "codeName": "L1validations",
        "numLeafTests": 32,
        "rows": [
          {
            "rowType": "group",
            "name": "**CONFIRM_CONTEXT**",
            "group": "",
            "scope": "",
            "description": "Sub-tests: CONTEXT_REQUIRED, CONTEXT_ENUM, CONTEXT_REGEX",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "group",
            "name": "**CONTEXT_REQUIRED**",
            "group": "CONFIRM_CONTEXT",
            "scope": "",
            "description": "Sub-tests: REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE, REQUIRED_CONTEXT_LOCATION_CITY_CODE, REQUIRED_CONTEXT_DOMAIN, REQUIRED_CONTEXT_TIMESTAMP, REQUIRED_CONTEXT_BAP_ID, REQUIRED_CONTEXT_BAP_URI, REQUIRED_CONTEXT_BPP_ID, REQUIRED_CONTEXT_BPP_URI, REQUIRED_CONTEXT_TRANSACTION_ID, REQUIRED_CONTEXT_MESSAGE_ID, REQUIRED_CONTEXT_VERSION, REQUIRED_CONTEXT_TTL",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
            "group": "CONFIRM_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.country.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
            "group": "CONFIRM_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.city.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          }
        ]
      },
      "on_confirm": {
        "action": "on_confirm",
        "codeName": "L1validations",
        "numLeafTests": 51,
        "rows": [
          {
            "rowType": "group",
            "name": "**ON_CONFIRM_CONTEXT**",
            "group": "",
            "scope": "",
            "description": "Sub-tests: CONTEXT_REQUIRED, CONTEXT_ENUM, CONTEXT_REGEX",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "group",
            "name": "**CONTEXT_REQUIRED**",
            "group": "ON_CONFIRM_CONTEXT",
            "scope": "",
            "description": "Sub-tests: REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE, REQUIRED_CONTEXT_LOCATION_CITY_CODE, REQUIRED_CONTEXT_DOMAIN, REQUIRED_CONTEXT_TIMESTAMP, REQUIRED_CONTEXT_BAP_ID, REQUIRED_CONTEXT_BAP_URI, REQUIRED_CONTEXT_BPP_ID, REQUIRED_CONTEXT_BPP_URI, REQUIRED_CONTEXT_TRANSACTION_ID, REQUIRED_CONTEXT_MESSAGE_ID, REQUIRED_CONTEXT_VERSION, REQUIRED_CONTEXT_TTL",
            "skipIf": "",
            "errorCode": "",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
            "group": "ON_CONFIRM_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.country.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          },
          {
            "rowType": "leaf",
            "name": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
            "group": "ON_CONFIRM_CONTEXT > CONTEXT_REQUIRED",
            "scope": "",
            "description": "- $.context.location.city.code must be present in the payload",
            "skipIf": "",
            "errorCode": "30000",
            "successCode": ""
          }
        ]
      }
    }
  },
  "attributes": [
    {
      "domain": "ONDC:FIS12",
      "useCaseId": "GOLD LOAN",
      "version": "2.0.3",
      "attributeSet": {
        "search": {
          "_description": {
            "required": true,
            "usage": "--",
            "info": "<placeholder description>",
            "owner": "BAP",
            "type": "object"
          },
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BAP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BAP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BAP",
                  "type": "object"
                }
              }
            }
          }
        },
        "on_search": {
          "_description": {
            "required": true,
            "usage": "--",
            "info": "<placeholder description>",
            "owner": "BAP",
            "type": "object"
          },
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BPP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BPP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BPP",
                  "type": "object"
                }
              }
            }
          }
        },
        "confirm": {
          "_description": {
            "required": true,
            "usage": "--",
            "info": "<placeholder description>",
            "owner": "BAP",
            "type": "object"
          },
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BAP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BAP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BAP",
                  "type": "object"
                }
              }
            }
          }
        },
        "on_confirm": {
          "_description": {
            "required": true,
            "usage": "--",
            "info": "<placeholder description>",
            "owner": "BAP",
            "type": "object"
          },
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BPP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BPP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BPP",
                  "type": "object"
                }
              }
            }
          }
        }
      }
    },
    {
      "domain": "ONDC:FIS12",
      "useCaseId": "PERSONAL LOAN",
      "version": "2.0.3",
      "attributeSet": {
        "search": {
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BAP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BAP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BAP",
                  "type": "object"
                },
                "code": {
                  "_description": {
                    "required": true,
                    "usage": "IND",
                    "info": "Country code in ISO 3166-1 or ISO 3166-2 format that the BAP provides to define the geographic scope for the search request.",
                    "owner": "BAP",
                    "type": "enum",
                    "enums": [
                      {
                        "code": "IND",
                        "description": "Represents the country",
                        "reference": "<PR/Issue/Discussion Links md format text>"
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        "on_search": {
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BPP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BPP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BPP",
                  "type": "object"
                },
                "code": {
                  "_description": {
                    "required": true,
                    "usage": "IND",
                    "info": "Country code in ISO 3166-1 or ISO 3166-2 format that the BAP provides to define the geographic scope for the search request.",
                    "owner": "BPP",
                    "type": "enum",
                    "enums": [
                      {
                        "code": "IND",
                        "description": "Represents the country",
                        "reference": "<PR/Issue/Discussion Links md format text>"
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        "confirm": {
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BAP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BAP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BAP",
                  "type": "object"
                },
                "code": {
                  "_description": {
                    "required": true,
                    "usage": "IND",
                    "info": "Country code in ISO 3166-1 or ISO 3166-2 format that the BAP provides to define the geographic scope for the search request.",
                    "owner": "BAP",
                    "type": "enum",
                    "enums": [
                      {
                        "code": "IND",
                        "description": "Represents the country",
                        "reference": "<PR/Issue/Discussion Links md format text>"
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        "on_confirm": {
          "context": {
            "_description": {
              "required": true,
              "usage": "",
              "info": "The BAP populates context on search to frame the transaction with the domain, routing, protocol, and session metadata that identifies the end-to-end interaction, and this same context must accompany the exchange so later callbacks can be correlated back to the request.",
              "owner": "BPP",
              "type": "object"
            },
            "action": {
              "_description": {
                "required": true,
                "usage": "search",
                "info": "Describes the Beckn protocol method being called by the sender and executed at the receiver. \n\n",
                "owner": "BAP",
                "type": "string"
              }
            },
            "location": {
              "_description": {
                "required": true,
                "usage": "",
                "info": "The BAP uses this container in search to state the location where the transaction is intended to be fulfilled, and the BPP carries that location forward in on_search.",
                "owner": "BPP",
                "type": "object"
              },
              "country": {
                "_description": {
                  "required": true,
                  "usage": "",
                  "info": "The BAP includes the country for the location in the search context so the search is scoped to the jurisdiction the service is being discovered in.",
                  "owner": "BPP",
                  "type": "object"
                },
                "code": {
                  "_description": {
                    "required": true,
                    "usage": "IND",
                    "info": "Country code in ISO 3166-1 or ISO 3166-2 format that the BAP provides to define the geographic scope for the search request.",
                    "owner": "BPP",
                    "type": "enum",
                    "enums": [
                      {
                        "code": "IND",
                        "description": "Represents the country",
                        "reference": "<PR/Issue/Discussion Links md format text>"
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      }
    }
  ],
  "validations": {
    "domain": "ONDC:FIS12",
    "version": "2.0.3",
    "validations": {
      "_TESTS_": {
        "search": [
          {
            "_NAME_": "SEARCH_CONTEXT",
            "action": [
              "search"
            ],
            "domain": [
              "ONDC:FIS12"
            ],
            "version": [
              "2.0.3"
            ],
            "_RETURN_": [
              {
                "_NAME_": "CONTEXT_REQUIRED",
                "_RETURN_": [
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_ID",
                    "attr": "$.context.bpp_id",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_URI",
                    "attr": "$.context.bpp_uri",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TRANSACTION_ID",
                    "attr": "$.context.transaction_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_MESSAGE_ID",
                    "attr": "$.context.message_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_VERSION",
                    "attr": "$.context.version",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "_RETURN_": "attr are present"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_ENUM",
                "_RETURN_": [
                  {
                    "_NAME_": "VALID_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_CONTINUE_": "!(attr are present)",
                    "enumList": [
                      "IND"
                    ],
                    "_RETURN_": "attr any in enumList"
                  },
                  {
                    "_NAME_": "VALID_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "enumList": [
                      "ONDC:FIS12"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr all in enumList"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_REGEX",
                "_RETURN_": [
                  {
                    "_NAME_": "REGEX_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "reg": [
                      "^\\*$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "reg": [
                      "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "reg": [
                      "^(?!.*\\b(?:http|https|www)\\b)[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "reg": [
                      "^https?://([a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)*|localhost)(:\\d+)?(/.*)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "reg": [
                      "^P(?=\\\\d|T\\\\d)(\\\\d+Y)?(\\\\d+M)?(\\\\d+D)?(T(\\\\d+H)?(\\\\d+M)?(\\\\d+S)?)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  }
                ]
              }
            ]
          }
        ],
        "on_search": [
          {
            "_NAME_": "ON_SEARCH_CONTEXT",
            "action": [
              "on_search"
            ],
            "domain": [
              "ONDC:FIS12"
            ],
            "version": [
              "2.0.3"
            ],
            "_RETURN_": [
              {
                "_NAME_": "CONTEXT_REQUIRED",
                "_RETURN_": [
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_ID",
                    "attr": "$.context.bpp_id",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_URI",
                    "attr": "$.context.bpp_uri",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TRANSACTION_ID",
                    "attr": "$.context.transaction_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_MESSAGE_ID",
                    "attr": "$.context.message_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_VERSION",
                    "attr": "$.context.version",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "_RETURN_": "attr are present"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_ENUM",
                "_RETURN_": [
                  {
                    "_NAME_": "VALID_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_CONTINUE_": "!(attr are present)",
                    "enumList": [
                      "IND"
                    ],
                    "_RETURN_": "attr any in enumList"
                  },
                  {
                    "_NAME_": "VALID_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "enumList": [
                      "ONDC:FIS12"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr all in enumList"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_REGEX",
                "_RETURN_": [
                  {
                    "_NAME_": "REGEX_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "reg": [
                      "^\\*$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "reg": [
                      "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "reg": [
                      "^(?!.*\\b(?:http|https|www)\\b)[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "reg": [
                      "^https?://([a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)*|localhost)(:\\d+)?(/.*)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "reg": [
                      "^P(?=\\\\d|T\\\\d)(\\\\d+Y)?(\\\\d+M)?(\\\\d+D)?(T(\\\\d+H)?(\\\\d+M)?(\\\\d+S)?)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  }
                ]
              }
            ]
          }
        ],
        "confirm": [
          {
            "_NAME_": "CONFIRM_CONTEXT",
            "action": [
              "confirm"
            ],
            "domain": [
              "ONDC:FIS12"
            ],
            "version": [
              "2.0.3"
            ],
            "_RETURN_": [
              {
                "_NAME_": "CONTEXT_REQUIRED",
                "_RETURN_": [
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_ID",
                    "attr": "$.context.bpp_id",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_URI",
                    "attr": "$.context.bpp_uri",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TRANSACTION_ID",
                    "attr": "$.context.transaction_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_MESSAGE_ID",
                    "attr": "$.context.message_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_VERSION",
                    "attr": "$.context.version",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "_RETURN_": "attr are present"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_ENUM",
                "_RETURN_": [
                  {
                    "_NAME_": "VALID_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_CONTINUE_": "!(attr are present)",
                    "enumList": [
                      "IND"
                    ],
                    "_RETURN_": "attr any in enumList"
                  },
                  {
                    "_NAME_": "VALID_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "enumList": [
                      "ONDC:FIS12"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr all in enumList"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_REGEX",
                "_RETURN_": [
                  {
                    "_NAME_": "REGEX_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "reg": [
                      "^\\*$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "reg": [
                      "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "reg": [
                      "^(?!.*\\b(?:http|https|www)\\b)[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "reg": [
                      "^https?://([a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)*|localhost)(:\\d+)?(/.*)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "reg": [
                      "^P(?=\\\\d|T\\\\d)(\\\\d+Y)?(\\\\d+M)?(\\\\d+D)?(T(\\\\d+H)?(\\\\d+M)?(\\\\d+S)?)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  }
                ]
              }
            ]
          }
        ],
        "on_confirm": [
          {
            "_NAME_": "ON_CONFIRM_CONTEXT",
            "action": [
              "on_confirm"
            ],
            "domain": [
              "ONDC:FIS12"
            ],
            "version": [
              "2.0.3"
            ],
            "_RETURN_": [
              {
                "_NAME_": "CONTEXT_REQUIRED",
                "_RETURN_": [
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_ID",
                    "attr": "$.context.bpp_id",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_BPP_URI",
                    "attr": "$.context.bpp_uri",
                    "var_search": [
                      "search"
                    ],
                    "_CONTINUE_": "(action all in var_search)",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TRANSACTION_ID",
                    "attr": "$.context.transaction_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_MESSAGE_ID",
                    "attr": "$.context.message_id",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_VERSION",
                    "attr": "$.context.version",
                    "_RETURN_": "attr are present"
                  },
                  {
                    "_NAME_": "REQUIRED_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "_RETURN_": "attr are present"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_ENUM",
                "_RETURN_": [
                  {
                    "_NAME_": "VALID_CONTEXT_LOCATION_COUNTRY_CODE",
                    "attr": "$.context.location.country.code",
                    "_CONTINUE_": "!(attr are present)",
                    "enumList": [
                      "IND"
                    ],
                    "_RETURN_": "attr any in enumList"
                  },
                  {
                    "_NAME_": "VALID_CONTEXT_DOMAIN",
                    "attr": "$.context.domain",
                    "enumList": [
                      "ONDC:FIS12"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr all in enumList"
                  }
                ]
              },
              {
                "_NAME_": "CONTEXT_REGEX",
                "_RETURN_": [
                  {
                    "_NAME_": "REGEX_CONTEXT_LOCATION_CITY_CODE",
                    "attr": "$.context.location.city.code",
                    "reg": [
                      "^\\*$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TIMESTAMP",
                    "attr": "$.context.timestamp",
                    "reg": [
                      "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_ID",
                    "attr": "$.context.bap_id",
                    "reg": [
                      "^(?!.*\\b(?:http|https|www)\\b)[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_BAP_URI",
                    "attr": "$.context.bap_uri",
                    "reg": [
                      "^https?://([a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)*|localhost)(:\\d+)?(/.*)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  },
                  {
                    "_NAME_": "REGEX_CONTEXT_TTL",
                    "attr": "$.context.ttl",
                    "reg": [
                      "^P(?=\\\\d|T\\\\d)(\\\\d+Y)?(\\\\d+M)?(\\\\d+D)?(T(\\\\d+H)?(\\\\d+M)?(\\\\d+S)?)?$"
                    ],
                    "_CONTINUE_": "!(attr are present)",
                    "_RETURN_": "attr follow regex reg"
                  }
                ]
              }
            ]
          }
        ]
      },
      "_SESSION_DATA_": {
        "tx": {}
      }
    }
  },
  "changelog": [
    {
      "schemaVersion": 1,
      "generatedAt": "2026-09-01T13:21:10.186Z",
      "summary": {
        "totalChanges": 67,
        "sections": [
          {
            "section": "flows",
            "label": "Flows",
            "count": 27
          },
          {
            "section": "attributes",
            "label": "Attributes",
            "count": 18
          },
          {
            "section": "actions",
            "label": "Supported Actions",
            "count": 21
          },
          {
            "section": "paths",
            "label": "API Paths",
            "count": 1
          }
        ]
      },
      "domain": "ONDC:FIS12",
      "version": "2.0.3",
      "fromVersion": "2.0.3",
      "toVersion": "2.0.3",
      "totalChanges": 67
    }
  ]
};
