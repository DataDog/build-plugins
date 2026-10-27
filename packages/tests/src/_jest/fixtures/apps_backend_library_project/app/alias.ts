// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// The viz library installed under an npm alias, its backend function imported by that alias.
import { fetchSeries } from 'viz-alias/backend';

void fetchSeries('avg:system.cpu.user{*}');
